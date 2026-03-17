# docs

Documentation app for `runtimeuse`, built with React Router and Fumadocs.

## Local Development

Install dependencies and start the dev server from this directory:

```bash
npm install
npm run dev
```

## Available Scripts

```bash
npm run dev         # start the local docs app
npm run build       # create a production build
npm run start       # serve the built site
npm run types:check # generate route/docs types and run TypeScript checks
npm run lint        # run Biome checks
npm run format      # format the docs app with Biome
```

## Project Layout

- `content/docs` contains the MDX documentation content.
- `app` contains the React Router application and search/UI code.
- `source.config.ts` configures the Fumadocs content source.
