# Pi OMLX Picker

> Seamlessly integrate your local [oMLX](https://github.com/jundot/omlx) models into Pi.

This extension discovers models from a local OMLX server and registers them as native Pi providers. Switch between your local and remote models effortlessly using Pi's built-in `/model` command.

![Pi OMLX Picker Demo](./.assets/demo.gif)

## ✨ Features

* **Zero-Friction Discovery:** Automatically fetches and registers available OMLX models on startup.
* **Native Integration:** Models show up in the standard `/model` menu—no custom commands needed for chat.
* **Smart Overrides:** Applies per-request thinking controls based on each model's `thinkingDefault` metadata.

## 📦 Installation

```sh
pi install npm:pi-omlx-picker
```

## 🚀 Quick Start

1. Run `/omlx-login` in Pi.
2. Paste your OMLX base URL and API key when prompted.
3. Type `/model` to see and select your OMLX models.

Re-run `/omlx-login` to update credentials.

## ⚙️ Configuration

Env-var overrides, model metadata overlay, and stream timeout knobs are documented in [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).
