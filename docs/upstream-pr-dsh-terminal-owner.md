# Allow browser terminal owners without an execution Agent

Browser terminals currently obtain their process provider, directory callbacks and cleanup lifetime from an Agent. An authorized source workspace with its own filesystem and subprocess services cannot reuse screen recovery, retention and input acknowledgements without constructing an Agent.

Export `createTerminalOwner(scope, owner, config)` from `@deepseek-ai/dsh-api-terminal-controller`. The factory accepts the actual resource scope, Session address, subprocess provider and current/validated directory callbacks. Its owner controller exposes the existing terminal operations with an explicit physical attachment uplink and carrier input window. The Agent Remote facade delegates to the same owner implementation and keeps its lookup, working-directory recovery, provider checks and deployment configuration.

The public factory creates no Agent and registers no Remote endpoint. Integrating services remain responsible for authenticated source routing and resource authorization. User terminals keep the execution environment's system-user permissions and credential scrub; they remain independent of Agent sandbox and approval policy. Terminal request/result types, frames, errors and the existing Remote namespace remain unchanged. Internal terminal implementation classes remain private to the package.

Tests cover independent owners, creation/close races, teardown failure/retry, attachment acknowledgements, unchanged Agent behavior and a real app/Loader composition with the native subprocess provider. The latter loads `cordis.yml` without Agent services, writes and reads an isolated workspace file, reconnects to the same shell PID and confirms explicit close ends that process. A development-only `dsh-app-boot` dependency supports this composition test. The package README pair documents the new API and lifetime semantics.

This is an upstream PR draft. It has not been submitted or pushed. Actual validation results and installation limits belong to the local delivery report; this draft does not claim browser, phone or final Host/Runner acceptance.
