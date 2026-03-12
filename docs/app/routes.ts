import { index, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  route('api/search', 'routes/search.ts'),

  // LLM integration:
  route('llms.txt', 'llms/index.ts'),
  route('llms-full.txt', 'llms/full.ts'),
  route('llms.mdx/*', 'llms/mdx.ts'),

  index('routes/docs.tsx'),
  route('*', 'routes/docs.tsx', { id: 'docs-splat' }),
] satisfies RouteConfig;
