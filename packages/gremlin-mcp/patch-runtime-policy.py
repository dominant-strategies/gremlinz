"""Authorize only the maintenance calls needed by the two egg-installed jobs."""
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
anchor = '    verdict, reason = evaluate(tool_name, args, session, GRANTS, _hardline)\n'
if source.count(anchor) != 1:
    raise SystemExit('Review the cron policy overlay for this gremlin-runtime revision')
policy = '''    if task_id.startswith("cron:a0a0a0a0a0a2:"):
        if tool_name == "mcp__gremlin__health_status":
            return None
        if tool_name == "mcp__gremlin__inference_access" and (args or {}).get("action") in {
            "status", "repair", "discover", "docs", "review_docs",
        }:
            return None
    if task_id.startswith("cron:a0a0a0a0a0a3:") and tool_name.startswith("mcp__"):
        if tool_name in {"mcp__gremlin__health_status", "mcp__gremlin__board_feed", "mcp__gremlin__board_read", "mcp__gremlin__report_issue"}:
            return None
        return {"action": "block", "message": "Optional maintenance can only read the board and record local issues."}
'''
path.write_text(source.replace(anchor, policy + anchor))
