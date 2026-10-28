# Architecture Map Prompt

> Reusable prompt for regenerating the interactive architecture map. Pipe this
> file into Claude CLI (or any capable coding agent) when the codebase changes
> substantially.

---

You are an elite software architect and interactive visualization expert.

Your task is to deeply analyze this entire repository and generate TWO files
that make the entire codebase self-documenting for both humans and future AI
agents:

1. `architecture.json` – A complete, structured machine-readable map of the
   architecture.
2. `architecture.html` – A beautiful, single-file, fully interactive
   architecture diagram (exactly like the ToDesktop demo in the video from
   @RoundtableSpace).

### Step-by-step process you must follow:

1. Thoroughly explore the entire codebase (directory structure, key files,
   READMEs, package.json, config files, source code, etc.).
2. Understand the project purpose, tech stack, major components, services, data
   flows, external integrations, build/deployment pipeline, and user/system
   journeys.
3. Build a precise mental model of how everything connects.

### Output 1: architecture.json

Create a clean, well-structured JSON with this exact schema (add extra fields if
needed for accuracy):

```json
{
  "projectName": "Exact project name",
  "description": "One-paragraph overview of what the app does",
  "techStack": {
    "frontend": [],
    "backend": [],
    "database": [],
    "services": [],
    "infrastructure": [],
    "external": []
  },
  "layers": [
    "client",
    "api",
    "functions",
    "storage",
    "build-pipeline",
    "distribution",
    "external-services"
  ],
  "nodes": [
    {
      "id": "unique-id",
      "label": "Node name",
      "type": "frontend|backend|function|database|service|pipeline|external",
      "layer": "one of the layers above",
      "technology": "Next.js / Firebase / AWS etc.",
      "description": "What this component does",
      "filePaths": ["src/app/...", "lib/..."],
      "responsibilities": ["list of key responsibilities"]
    }
  ],
  "edges": [
    {
      "from": "node-id",
      "to": "node-id",
      "label": "short description",
      "type": "api|event|data|auth|trigger|build|deployment"
    }
  ],
  "keyFlows": [
    {
      "id": "flow-id",
      "name": "Descriptive flow name (e.g. 'User Signup', 'Build & Release', 'Payment Processing')",
      "description": "What this flow does",
      "path": ["node-id-1", "node-id-2", "..."],
      "steps": [
        {
          "step": 1,
          "node": "node-id",
          "description": "Detailed explanation of what happens at this step"
        }
      ]
    }
  ]
}
```

### Output 2: architecture.html

Create a single self-contained HTML file that looks and behaves exactly like the
interactive diagram in the video:

- Dark modern theme (same aesthetic as the ToDesktop example)
- Main interactive graph area showing all nodes and connections (use
  Cytoscape.js via CDN or a clean Tailwind + SVG + vanilla JS implementation
  that feels premium)
- Nodes are clearly labeled, grouped by layers/swimlanes where possible
- Right sidebar titled **FLOWS** – list of all keyFlows from the JSON. Clicking
  a flow:
  - Highlights the exact path in the graph (yellow/glow lines + highlighted
    nodes, just like the video)
  - Shows a **STEPS** panel below the flows with numbered, detailed step-by-step
    annotations (exactly as in the video)
- Top legend explaining colors/symbols
- Search bar to quickly find any component
- Ability to click any node individually to highlight all its connections
- Hover tooltips with full node details
- Responsive, polished, and professional (Tailwind via CDN)
- Title at the top: **"[Project Name] - Architecture & Flows"**
- Subtitle: **"Every package and external service that powers this app. Click a
  flow on the right to highlight the path through the system."**

Place both files in a new folder `./docs/architecture/` (or root if you prefer).

Start by exploring the repo in detail. Then output the two files. Make this the
highest-quality, most useful architecture visualization possible - this should
become the single source of truth for anyone (human or AI) working on the
codebase.

---

### How to run

```bash
# From repo root, pipe this prompt into Claude CLI
claude -p "$(cat docs/prompts/architecture.md)"
```

Or open Claude Code interactively and paste this prompt. The agent will
regenerate `docs/architecture/architecture.{json,html}`.

### When to regenerate

- A new app, package, or worker is added
- A major external integration is added or removed
- A user-facing flow changes (e.g., new auth provider, payment flow, AI agent)
- Quarterly, as a freshness check

### Output locations

- `docs/architecture/architecture.json` - machine-readable map for AI agents.
- `docs/architecture/architecture.html` - interactive graph for humans.
- The high-level scrollable reference (companion) lives at the repo root:
  `ARCHITECTURE.html` / `ARCHITECTURE.json`.
