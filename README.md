# Air1

Air1 是一个轻量、安静、专注表达的中文 Hugo 站点，可以直接部署到 Cloudflare Pages。

## 项目结构

```text
config.toml
content/
themes/air1/
```

根目录是网站本体，`themes/air1/` 是站点主题。

## Cloudflare Pages

部署配置：

```text
Framework preset: Hugo
Build command: hugo --gc --minify
Build output directory: public
Root directory: /
```

建议环境变量：

```text
HUGO_VERSION = 0.147.7
```

站点使用相对链接，因此可以直接运行在 `*.pages.dev`，也可以绑定自定义域名。

## 本地开发

```bash
hugo server
```

构建：

```bash
hugo --gc --minify
```

## 许可

Air1 站点内容采用 MIT License。`themes/air1/` 中包含的主题代码保留其来源许可声明。
