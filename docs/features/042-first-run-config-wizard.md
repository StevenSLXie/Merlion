# Feature 042: First-Run Configuration Wizard

## Status

`done`

## Problem

When a user installs Merlion (e.g. via `npm install -g merlion`) and runs it for
the first time, there is no API key or model configured. The current behaviour is
a terse error message:

```
OPENROUTER_API_KEY is required.
```

This is a bad first experience. A new user has no idea where to put the key or
which model to use.

## Goal

On first run (and whenever the stored config is absent or incomplete), launch an
interactive setup wizard that:

1. Explains what is needed (OpenRouter API key + model ID).
2. Prompts the user to paste their key (input is hidden so it does not appear in
   shell history).
3. Prompts for a model ID with a sensible default.
4. Saves the config to `~/.config/merlion/config.json`.
5. Continues immediately into the requested task without requiring a restart.

Subsequent runs load the saved config silently — no wizard, no friction.

## Config file

**Location**: `~/.config/merlion/config.json`

Respects the `XDG_CONFIG_HOME` environment variable when set.

**Schema**:

```jsonc
{
  "apiKey": "sk-or-...",       // OpenRouter API key
  "model": "google/gemini-...", // model ID passed to the provider
  "baseURL": "https://openrouter.ai/api/v1"  // optional override
}
```

All fields are optional in the file — missing fields fall back to defaults or
env vars.

## Priority order (highest → lowest)

```
CLI flag (--model, --base-url)
  > environment variable (OPENROUTER_API_KEY, MERLION_MODEL, MERLION_BASE_URL)
    > config file (~/.config/merlion/config.json)
      > built-in default
```

The wizard is triggered only when **no API key is available** from any source
above the config file.

## UX flow

```
┌─────────────────────────────────────────────────────────┐
│  Merlion Setup                                          │
│                                                         │
│  No API key found. Let's get you set up.               │
│                                                         │
│  OpenRouter API key: ****************************       │
│  Model [google/gemini-2.5-flash]:                      │
│                                                         │
│  Config saved to ~/.config/merlion/config.json         │
│  Run `merlion config` at any time to update settings.  │
└─────────────────────────────────────────────────────────┘
```

- API key input uses `readline` with output muted so the key is never echoed.
- Pressing Enter on the model prompt accepts the shown default.
- If the user sends EOF (Ctrl-D) or leaves the key blank, the wizard aborts with
  a helpful message pointing to environment variable setup.

## `merlion config` sub-command

Running `merlion config` (or `merlion --config`) re-runs the wizard regardless
of whether a config already exists, allowing users to rotate keys or switch
models.

## Modules

| Path | Responsibility |
|------|----------------|
| `src/config/store.ts` | Read / write / merge config file |
| `src/config/wizard.ts` | Interactive prompts + save flow |
| `src/index.ts` | Wire: load config → maybe run wizard → proceed |

## Security notes

- The config file is written with mode `0o600` (owner read/write only) on
  POSIX systems.
- The key is stored in plaintext. Users who need stronger protection should use
  an env var or a secrets manager and skip the wizard.
- The key is never printed back to the terminal after initial entry.

## Tests

- `tests/config_store.test.ts` — read missing file, write + read round-trip,
  merge priority, XDG_CONFIG_HOME override, file permission bits.
- `tests/config_wizard.test.ts` — wizard with valid input, wizard with blank key
  (abort), wizard with default model accepted.
