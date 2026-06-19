# Perry

[Perry](https://github.com/raunak42/perry) is a terminal-native coding agent with tools, planning, MCP, skills, permissions, and subagents. It ships as the npm package `@perry-ai/cli` and installs a `perry` binary.

![Perry terminal preview](./assets/ansi_cutout.png)

## Why I built it?

I built Perry because I wanted a fast, terminal-first coding assistant that feels native to my workflow. The goal is to keep the core loop practical: inspect files, edit code, run commands, reason through plans, use external context when needed, and preserve enough session state to continue real engineering work without turning the terminal into a heavy app.

## Tech stack

- TypeScript
- Bun
- Node.js
- OpenAI Responses API
- ChatGPT/Codex OAuth backend
- Commander
- Express
- MCP over stdio
- JSONL session persistence
- npm

## Some diagrams

### High-Level System Architecture

```mermaid
graph TB
    User(["Terminal User"])

    subgraph CLI["Perry CLI — src/index.ts"]
        REPL["REPL Loop<br/>+ Slash Commands"]
        Prompt["System Prompt Builder<br/>(constants.ts)"]
        SessionRT["Session Runtime<br/>(sessionRuntime.ts)"]
    end

    TUI["Terminal UI<br/>(src/ui/*)"]

    subgraph Auth["Auth — src/auth"]
        SubAuth["Subscription OAuth<br/>(PKCE, ChatGPT login)"]
        ApiAuth["API Key Auth"]
        AuthFile[("auth.json")]
    end

    subgraph Providers["Model Providers"]
        CodexAPI["ChatGPT Codex backend<br/>chatgpt.com/backend-api/codex/responses"]
        OpenAIAPI["OpenAI Responses API<br/>api.openai.com"]
    end

    subgraph Tools["Local Tools — src/tools"]
        Read["read"]
        Write["write"]
        Edit["edit"]
        Run["run_command"]
        Subagent["spawn_subagent"]
        PlanTools["plan_choice / plan_complete"]
    end

    subgraph Helpers["Core Helpers — src/helpers"]
        Perm["permissions.ts"]
        PlanMode["planMode.ts"]
        Subagents["subagents.ts"]
        Mcp["mcp.ts (McpManager)"]
        Skills["skills.ts"]
        Compaction["compaction.ts"]
        SessionMgr["sessionManager.ts"]
    end

    McpServers[("External MCP Servers<br/>stdio child processes")]
    SessionFiles[("Session JSONL files<br/>~/.perry-ai/sessions")]
    SkillFiles[("SKILL.md files<br/>global + .perry/skills")]
    ProjectCtx[("AGENTS.md / CLAUDE.md<br/>SELF_MANIFEST.md")]
    FS[("Project Filesystem")]
    Shell[("Shell / OS Processes")]

    User <--> TUI
    TUI <--> REPL
    REPL --> Prompt
    Prompt --> ProjectCtx
    Prompt --> Skills
    REPL --> Auth
    SubAuth --> AuthFile
    ApiAuth --> AuthFile
    REPL -->|"activeProvider = openai-codex"| CodexAPI
    REPL -->|"activeProvider = openai-api-key"| OpenAIAPI
    AuthFile -.->|"bearer token"| CodexAPI
    AuthFile -.->|"api key"| OpenAIAPI

    REPL --> Perm
    REPL --> PlanMode
    REPL --> Subagents
    REPL --> Mcp
    REPL --> SessionMgr
    REPL --> Compaction
    SessionRT --> SessionMgr

    Perm --> Tools
    Read --> FS
    Write --> FS
    Edit --> FS
    Run --> Shell
    Subagents --> Subagent
    Subagent -.->|"recursive agent loop, depth ≤ 2"| REPL

    Mcp --> McpServers
    McpServers -.->|"JSON-RPC over stdio"| Mcp
    Mcp -->|"wrapped as Tool mcp__server__tool"| Tools

    Skills --> SkillFiles
    SessionMgr --> SessionFiles
```

### Core Agent Turn / Tool-Calling Loop

```mermaid
sequenceDiagram
    participant Runtime as Turn Loop
    participant Codex as ChatGPT Codex backend
    participant OAI as OpenAI Responses API
    participant Tools as Local Tools + MCP
    participant UI as Terminal UI

    loop Per turn until no tool calls
        alt activeProvider == openai-codex
            Runtime->>Codex: POST /codex/responses
            Codex-->>Runtime: reasoning deltas, text deltas, function calls
        else activeProvider == openai-api-key
            Runtime->>OAI: responses.create
            OAI-->>Runtime: reasoning deltas, text deltas, function calls
        end

        Runtime->>UI: stream output

        alt Tool calls present
            Runtime->>Tools: executeLocalToolCalls()
            Tools-->>Runtime: function_call_output
        else No tool calls
            Runtime->>UI: render final response
        end
    end
```

### Tool Execution & Permission Pipeline

```mermaid
flowchart TD
    A(["function_call from model"]) --> B["JSON.parse(arguments)"]
    B -- invalid --> Z1["Return error to model"]
    B -- valid --> C{"Plan mode active?"}
    C -- yes --> D{"Tool allowed in plan mode?<br/>(read, run_command, web_search, spawn_subagent)"}
    D -- no --> Z2["Blocked: plan mode restriction"]
    D -- "yes, run_command" --> E{"Command matches a<br/>plan-mode-blocked mutation pattern?"}
    E -- yes --> Z2
    E -- no --> F
    D -- "yes, other tool" --> F
    C -- no --> F["evaluateToolPermission(mode, tool, args)"]
    F --> G{"Permission action"}
    G -- deny --> Z3["Blocked by permissions"]
    G -- allow --> H["tool.execute(args)"]
    G -- ask --> I{"autoApprovePermissionPrompts?<br/>(true for subagents)"}
    I -- yes --> H
    I -- no --> J["Prompt user in TUI: Allow / Deny"]
    J -- approve --> H
    J -- deny --> Z4["Denied by user"]
    H --> K["Stream live output to TUI (onUpdate)"]
    K --> L(["function_call_output → model"])
    Z1 & Z2 & Z3 & Z4 --> L
```

### Subagent Orchestration

```mermaid
sequenceDiagram
    participant Main as Main Agent Loop
    participant Exec as executeLocalToolCalls
    participant SA1 as Subagent #1
    participant SA2 as Subagent #2
    participant Provider

    Main->>Provider: turn request
    Provider-->>Main: 2× function_call spawn_subagent (independent tasks)
    Main->>Exec: executeLocalToolCalls([spawn_subagent, spawn_subagent])
    Note over Exec: consecutive spawn_subagent calls are<br/>grouped and permission-checked together
    par Parallel execution
        Exec->>SA1: runSubagentLoop(task A, depth+1)
        SA1->>Provider: isolated conversation, own tool loop
        Provider-->>SA1: text / tool calls (read, run_command,<br/>nested spawn_subagent if depth < 2)
        SA1-->>Exec: final report (≤ maxTurns, default 8, cap 12)
    and
        Exec->>SA2: runSubagentLoop(task B, depth+1)
        SA2->>Provider: isolated conversation, own tool loop
        Provider-->>SA2: text / tool calls
        SA2-->>Exec: final report
    end
    Exec-->>Main: function_call_output per spawn_subagent call
    Main->>Provider: continue main turn with both reports
```

## Contributing

1. Fork the repo.
2. Clone the forked repo.
3.
```sh
cd perry
bun install
```
4.
```sh
bun run dev
```
5. In another terminal, run checks before opening a PR:
```sh
bun x tsc --noEmit
bun test
```

The development CLI is now running! Make your code contributions and open some PRs!!!
