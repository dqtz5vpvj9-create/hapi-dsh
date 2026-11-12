# Optional source-owned idle queue start in QueueDock

A stopped external Session may retain its native inbox while offering no active-turn steering. Add an optional `queueActions[row].start` capability and an explicit `QueueAction.start`, rendered by the existing QueueDock arrow. The source receives the exact item ID; ordinary DSH rejects the source-only action before cold-Agent resolution, and absent projection keeps the existing UI unchanged.

The label communicates that starting the selected message may continue the source queue afterwards. It does not automatically restart an interrupted source, reinterpret Steer or add a second queue renderer. Tests cover explicit idle capability, single-click dispatch/held operation, normal running Steer and ordinary rejection without Agent resolution. No upstream push is authorized or performed.
