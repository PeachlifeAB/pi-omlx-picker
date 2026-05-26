# Pi OMLX Picker

> Seamlessly integrate your local [oMLX](https://github.com/jundot/omlx) models into Pi.

This extension discovers models from a local OMLX server and registers them as native Pi providers.
Switch between your local and remote models effortlessly using Pi's built-in `/model` command.

![Pi OMLX Picker Demo](./.assets/demo.gif)

## ✨ Features

* Auto discovery: fetches and registers available OMLX models without blocking Pi startup.
* Native integration: login uses Pi's standard `/login`, and models use Pi's standard `/model` menu.
* Smart overrides: applies per-request thinking controls based on each model's `thinkingDefault` metadata.

## 📦 Installation

```bash
pi install npm:pi-omlx-picker
```

## 🛠️ Development

* `npm install`
* `npm run check`
* `npm run format`
* `npm test`
* `npm run test:watch`

## 🚀 Quick Start

1. Start your local OMLX server.
2. Run `/login` in Pi, choose **API key**, then choose **OMLX**.
3. Enter your OMLX API key.
4. Type `/model` to see and select your OMLX models.

The default base URL is `http://127.0.0.1:8000/v1`. Set `OMLX_BASE_URL` before starting Pi if your OMLX server uses a different URL.


## ⚙️ Configuration

Env-var overrides, model metadata overlay, and stream timeout knobs are documented in [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).
