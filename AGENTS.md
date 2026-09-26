# SillyTavern fork working boundary

- Develop in this fork checkout. Use the workspace integration sandbox and its separate test data for verification.
- Follow the workspace root AGENTS.md. Production `runtime/data` contents, metadata and data-derived API responses must not be inspected or used for verification.
- With explicit user authorization, deploy this fork's code and bundled default content to `runtime/apps/SillyTavern` and release copies. This includes SillyTavern core code and extensions. Required service restarts are covered by that deployment authorization after checking active work and connections.
- Preserve production user data. Deployment authorization does not permit inspecting user settings, chats or worlds, copying the full user-data tree, or changing credentials/security permissions.
- Verify changes in sandbox first. Commit and push when the user requests runtime deployment, following the user's standing agreement.
