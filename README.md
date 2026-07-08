# HugoPost

HugoPost is a minimal Hugo site using the Etch-style theme layout. It is ready to deploy on Cloudflare Pages as a static site.

## Structure

```text
config.toml
content/
themes/etch/
```

The site lives at the repository root. The theme lives in `themes/etch`.

## Cloudflare Pages

Use these settings:

```text
Framework preset: Hugo
Build command: hugo --gc --minify
Build output directory: public
Root directory: /
```

Recommended environment variable:

```text
HUGO_VERSION = 0.147.7
```

The site uses relative URLs, so it works on a `*.pages.dev` domain or a custom domain without changing `baseURL`.

## Local Development

```bash
hugo server
```

Build locally:

```bash
hugo --gc --minify
```
