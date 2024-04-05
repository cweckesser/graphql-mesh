import { GraphQLSchema } from 'graphql';
import type { Pool } from 'mysql';
import { PredefinedProxyOptions, StoreProxy } from '@graphql-mesh/store';
import {
  ImportFn,
  Logger,
  MeshHandler,
  MeshHandlerOptions,
  MeshPubSub,
  MeshSource,
  YamlConfig,
} from '@graphql-mesh/types';
import { loadFromModuleExportExpression } from '@graphql-mesh/utils';
import { getMySQLExecutor, loadGraphQLSchemaFromMySQL } from '@omnigraph/mysql';

export default class MySQLHandler implements MeshHandler {
  private name: string;
  private config: YamlConfig.MySQLHandler;
  private baseDir: string;
  private pubsub: MeshPubSub;
  private importFn: ImportFn;
  private schemaProxy: StoreProxy<GraphQLSchema>;
  private logger: Logger;

  constructor({
    name,
    config,
    baseDir,
    pubsub,
    logger,
    store,
    importFn,
  }: MeshHandlerOptions<YamlConfig.MySQLHandler>) {
    this.name = name;
    this.config = config;
    this.baseDir = baseDir;
    this.pubsub = pubsub;
    this.importFn = importFn;
    this.logger = logger;
    this.schemaProxy = store.proxy(
      'schema.graphql',
      PredefinedProxyOptions.GraphQLSchemaWithDiffing,
    );
  }

  async getMeshSource(): Promise<MeshSource> {
    const { pool: configPool } = this.config;
    const schema = await this.schemaProxy.getWithSet(() => {
      const endpointUrl = new URL('mysql://localhost:3306');
      if (this.config.port) {
        endpointUrl.port = this.config.port.toString();
      }
      if (this.config.host) {
        endpointUrl.hostname = this.config.host;
      }
      if (this.config.user) {
        endpointUrl.username = this.config.user;
      }
      if (this.config.password) {
        endpointUrl.password = this.config.password;
      }
      if (this.config.database) {
        endpointUrl.pathname = this.config.database;
      }
      if (this.config.ssl) {
        endpointUrl.protocol = 'mysqls:';
      }
      return loadGraphQLSchemaFromMySQL(this.name, {
        endpoint: endpointUrl.toString(),
        ssl: {
          rejectUnauthorized: this.config.ssl?.rejectUnauthorized,
          caPath: this.config.ssl?.ca,
        },
      });
    });

    const pool: Pool =
      typeof configPool === 'string'
        ? await loadFromModuleExportExpression(configPool, {
            cwd: this.baseDir,
            defaultExportName: 'default',
            importFn: this.importFn,
          })
        : configPool;

    return {
      schema,
      executor: getMySQLExecutor({
        subgraph: schema,
        pool,
        pubsub: this.pubsub,
        logger: this.logger,
      }),
    };
  }
}
