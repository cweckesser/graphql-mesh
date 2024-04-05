import { GraphQLError, TypeInfo, visit, visitInParallel, visitWithTypeInfo } from 'graphql';
import { Minimatch } from 'minimatch';
import { process } from '@graphql-mesh/cross-helpers';
import { stringInterpolator } from '@graphql-mesh/string-interpolation';
import { KeyValueCache, MeshPlugin, YamlConfig } from '@graphql-mesh/types';
import { createGraphQLError } from '@graphql-tools/utils';

function deleteNode<T extends Record<string | number, any>>(
  parent: T,
  remaining: (string | number)[],
  currentKey?: keyof T,
): void {
  const nextKey = remaining.shift();
  if (nextKey) {
    const nextParent = currentKey ? parent[currentKey] : parent;
    return deleteNode(nextParent, remaining, nextKey);
  }
  delete parent[currentKey];
}

export default function useMeshRateLimit({
  config,
  cache,
}: YamlConfig.RateLimitPluginConfig & {
  cache: KeyValueCache;
}): MeshPlugin<any> {
  return {
    async onExecute(onExecuteArgs) {
      const typeInfo = new TypeInfo(onExecuteArgs.args.schema);
      const errors: GraphQLError[] = [];
      const jobs: Promise<void>[] = [];
      let remainingFields = 0;
      visit(
        onExecuteArgs.args.document,
        visitInParallel(
          config.map(config => {
            const typeMatcher = new Minimatch(config.type);
            const fieldMatcher = new Minimatch(config.field);
            const identifier = stringInterpolator.parse(config.identifier, {
              env: process.env,
              root: onExecuteArgs.args.rootValue,
              context: onExecuteArgs.args.contextValue,
            });
            return visitWithTypeInfo(typeInfo, {
              Field: (fieldNode, key, parent, path) => {
                const parentType = typeInfo.getParentType();
                if (typeMatcher.match(parentType.name)) {
                  const fieldDef = typeInfo.getFieldDef();
                  if (fieldMatcher.match(fieldDef.name)) {
                    const cacheKey = `rate-limit-${identifier}-${parentType.name}.${fieldDef.name}`;
                    const remainingTokens$ = cache.get(cacheKey);
                    jobs.push(
                      remainingTokens$.then((remainingTokens: number): Promise<void> => {
                        if (remainingTokens == null) {
                          remainingTokens = config.max;
                        }

                        if (remainingTokens === 0) {
                          errors.push(
                            createGraphQLError(
                              `Rate limit of "${parentType.name}.${fieldDef.name}" exceeded for "${identifier}"`,
                              {
                                path: [fieldNode.alias?.value || fieldDef.name],
                                extensions: {
                                  http: {
                                    status: 429,
                                    headers: {
                                      'Retry-After': config.ttl,
                                    },
                                  },
                                },
                              },
                            ),
                          );
                          deleteNode(parent, [...path]);
                          remainingFields--;
                          return null;
                        }

                        return cache.set(cacheKey, remainingTokens - 1, {
                          ttl: config.ttl / 1000,
                        });
                      }),
                    );
                  }
                }
                remainingFields++;
                return false;
              },
            });
          }),
        ),
      );
      await Promise.all(jobs);
      if (errors.length > 0) {
        // If there is a field left in the final selection set
        if (remainingFields > 0) {
          // Add the errors to the final result
          return {
            onExecuteDone(onExecuteDoneArgs) {
              onExecuteDoneArgs.setResult({
                ...onExecuteDoneArgs.result,
                errors,
              });
            },
          };
        }

        // If there is no need to continue the execution, stop
        onExecuteArgs.setResultAndStopExecution({
          data: null,
          errors,
        });
      }
      return undefined;
    },
  };
}
