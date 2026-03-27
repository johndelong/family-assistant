# Frontend

This app is the thin admin/operator UI for the platform.

It intentionally keeps business logic out of the browser and talks directly to
the runtime's HTTP API for:

- health/status inspection
- extension management
- cron job management
- workflow and approval operations
- trace/monitor inspection
