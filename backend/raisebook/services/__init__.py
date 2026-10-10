"""Service layer. Route handlers and MCP tools call these; they never re-implement rules.

Conventions: workspace-scoped functions take ``ws: WorkspaceContext`` and filter by
``ws.workspace_id``; writes take an ``Actor`` (``ws.actor``) and log activities in
the same transaction; services flush, the caller (route or ``tool_call``) commits.
"""
