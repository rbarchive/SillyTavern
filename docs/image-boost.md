# Local image boost mode

Image Generation → ComfyUI → **부스트 모드**. New and existing settings without a preference default to ON; a saved OFF stays OFF. ON uses ComfyUI default cache and PyTorch cross attention. OFF uses cache-none and default attention. Model, workflow, dimensions, sampler and precision are unchanged.

The toggle controls a separately owned ComfyUI process. A mode change waits for accepted images to finish, then restarts that process. The first request after a switch pays process/model startup costs; later requests reuse the process. Preferences are per ST settings; execution modes are captured per request and serialized on the shared managed process. Existing external ComfyUI servers are never adopted or restarted. Remote/unconfigured connections display unsupported status and keep ordinary generation behavior.

Configure trusted host paths in `config.yaml` (disabled until the host explicitly configures it):

```yaml
localImageRuntime:
  enabled: true
  sourceUrl: http://127.0.0.1:8188
  port: 8190
  python: /absolute/path/to/venv/bin/python
  main: /absolute/path/to/ComfyUI/main.py
  modelPaths: /absolute/path/to/extra-model-paths.yaml
  dataDirectory: /absolute/path/to/separate-managed-comfy-data
```

Do not use another server's input/output/user directory or listening port. Paths and process flags cannot be provided by the browser. An occupied port or failed startup is reported and never silently falls back to the original server. Graceful ST shutdown drains accepted managed images and stops its owned child. A cancelled caller may discard the result, but running model inference is drained before a subsequent restart.

The original server can retain its own loaded models alongside this process; allow for that additional unified-memory use. Deployments should configure lifecycle and data isolation deliberately. Sandbox implementation does not change production services.
