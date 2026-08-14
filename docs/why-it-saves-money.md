# Why CacheLane saves money

**Kind:** product intuition (Anthropic Messages API + prompt cache). Not a live
savings measurement. This host's dual-lane install is a different surface —
see [`README.md`](README.md).


> **In one breath:** the Claude API is stateless, so Claude Code re-sends your whole conversation on every turn and you pay for it again and again. CacheLane marks the unchanging part with cache breakpoints so it stays identical and rides Anthropic's prompt cache at **one-tenth** the price, then trims stale tool output. The longer the session, the more you save.

### 1. The problem: the API is stateless

Claude does not keep your conversation on Anthropic's servers between requests. The Messages API is **stateless**, which means the client (Claude Code) has to send the **entire** conversation again on every turn:

```
Turn 1 sends:  [ system + tools ][ file ][ msg 1 ]
Turn 2 sends:  [ system + tools ][ file ][ msg 1 ][ reply ][ msg 2 ]
Turn 3 sends:  [ system + tools ][ file ][ msg 1 ][ reply ][ msg 2 ][ reply ][ msg 3 ]
                |............ the same stuff, re-sent every turn ............|
```

Normally you pay full price for all of it on every turn. That repetition is the waste CacheLane removes.

> **Source:** Anthropic, [Using the Messages API](https://docs.anthropic.com/en/api/messages-examples): *"The Messages API is stateless, which means that you always send the full conversational history to the API."* New turns are added by **appending** to the `messages` array, so conversation cost grows with length.
>
> **"But Claude has a memory feature."** That is a different mechanism and it does not change the above. Memory tools and memory files work by saving notes to a file and then reading that file back **into the prompt** on later turns. The content still travels inside every request; the model is not recalling it from a saved server-side session.

### 2. The discount it chases

Anthropic's prompt cache bills a *repeated prefix* at a fraction of the normal input price. The exact multipliers, straight from Anthropic's documentation:

| Token type | Price vs. base input |
|---|---|
| Normal input (uncached) | **1×** |
| Cache **write** (5-minute TTL) | **1.25×** |
| Cache **write** (1-hour TTL) | **2×** |
| Cache **read** (hit) | **0.1×** |

> **Source:** Anthropic, [Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching): *"5-minute cache write tokens are 1.25 times the base input tokens price; 1-hour cache write tokens are 2 times the base input tokens price; cache read tokens are 0.1 times the base input tokens price."* See also Anthropic [Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing).

The catch is in **how** the cache matches. Anthropic caches the **prefix** of a request up to a `cache_control` breakpoint, and a request reuses *"the longest prefix that a prior request already wrote to the cache."* The match stops at the first token that differs; everything after that point is billed at full price.

New turns append to the **end** of the conversation, so the front is naturally stable. The thing that actually breaks caching is **volatile content sitting ahead of stable content**: a freshly injected tool result, a changing system reminder, or a block whose order or formatting shifts between turns. If any of that lands before your expensive stable content (system prompt, tool schemas, large files), the prefix diverges early and the stable content after it can no longer be served from cache.

> **Source:** Anthropic, [Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching): *"Cache writes happen only at your breakpoint. Marking a block with `cache_control` writes exactly one cache entry: a hash of the prefix ending at that block."* The system *"automatically find[s] the longest prefix that a prior request already wrote to the cache."*
>
> **What about Anthropic's _automatic caching_?** Anthropic can place one breakpoint for you — on the *last cacheable block*, advanced as the conversation grows, with a 20-block lookback ([Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)). But it still only *places a breakpoint*: it never reorders your prompt and never prunes idle content. CacheLane's breakpoint placement is on par with using native caching well — its **additional** savings come from K-pruning and keepalive (below), which the API has no equivalent for.

### 3. The trick: mark the cache boundaries (without moving anything)

CacheLane classifies each request into three **volatility regions**. Marker
count depends on `features.marker_strategy` ([runbook-claude-effectiveness.md](runbook-claude-effectiveness.md)):

- `prefix_only` (code default) — one owned tools/system marker.
- `candidate` — bounded static-prefix / read-anchor / write-frontier plan (may be more than one).
- `passthrough` — keep the client's markers (this host's Claude home).

It does **not** reorder your conversation: the API already sends `system` and
`tools` before `messages`, and new turns append. Under `prefix_only` the owned
marker sits at the tools/system prefix:

```
+----------------------------------------+
| STABLE    system prompt, tool schemas  |  prefix_only marker here
| ============ cache breakpoint ======== |
| SEMI + VOLATILE  turns, files, tools   |  not a second owned marker
+----------------------------------------+
```

Under `prefix_only`, only **system + tools** sit before the owned marker. A file that arrived as a `Read` tool result lives in the messages suffix and is **not** in that cached prefix — it pays full price every turn unless a later strategy (`candidate`) or Claude Code's own markers cover it.

### 4. Worked example: system+tools prefix (`prefix_only`)

Say system+tools is **15,000 tokens** (the `prefix_only` cached span), and each new message + tool results is **500 tokens** outside that span.

| Turn | What happens | Cost (token-units) |
|------|--------------|--------------------|
| 1 | Prefix written at 1.25×; suffix full price | `15,000×1.25 + 500` ≈ **19,250** |
| 2 | Prefix cache hit at 0.1×; suffix still full price | `15,000×0.1 + 500` ≈ **2,000** |
| 3, 4, 5 … | Same, while the prefix stays byte-identical and in TTL | ≈ **2,000** each |

Per-turn cost collapses after the first turn:

```
cost/turn
 19k | #                              turn 1: pay once to seed the cache
     |
 10k |
     |
  2k |   #  #  #  #  #  #  #  #  #     every turn after: flat and cheap
     +-------------------------------
       1  2  3  4  5  6  7  8  9 ...
```

> **"Read that file again"?** Only if the bytes stay in the *same prefix position*
> (Claude Code still holds the first read in history). A *new* Read of the same path
> appends a new tool result in the volatile suffix and pays full price for that new
> occurrence. Prompt cache matches a prefix, not repeated substrings.

### 5. Why the savings grow with session length (the math)

Let `S` = the size of the **cached prefix** under the active marker strategy (`prefix_only`: system+tools only — **not** files already read). Over `N` turns, while that prefix stays in TTL:

```
Without caching:   N x S            (full 1x price, every turn)

With CacheLane:    1.25 * S         (write it once, on turn 1)
                 + (N - 1) * 0.1*S  (cheap 0.1x read, every turn after)
```

Divide the CacheLane cost by `N` to get the **average per-turn cost** (per unit of `S`):

```
  1.25*S + (N - 1)*0.1*S                  1.15
  ----------------------- =  ( 0.1  +  -------- ) * S
            N                              N
```

That single formula is the whole story (the multipliers `1.25` and `0.1` are the cited Anthropic rates above):

| Turns `N` | avg per-turn cost | savings vs. full price |
|-----------|-------------------|------------------------|
| 1 | 1.25× | (just the write) |
| 2 | 0.675× | ~32% |
| 10 | 0.215× | ~78% |
| 50 | 0.123× | ~88% |
| large N | **0.1×** | **90% (the ceiling)** |

As the session grows, the one-time `1.15/N` write cost shrinks toward zero and the average slides down to **0.1×**, i.e. a **90% discount** on the repeated part. That 90% is not a marketing number. It is exactly the cache-read multiplier (`0.1×`) from the table above, and it is the theoretical ceiling. Real sessions also carry a small always-full-price "new" part each turn plus the occasional cache miss, which pulls the *measured* number down to roughly **80%**, which is what `cachelane stats` reports in practice. Short chats sit low on this curve; long coding sessions ride near the top.

### 6. Keeping it lean: K-pruning and stubs

Caching makes the prompt *cheap*, but a long session still makes it *big*. Old tool outputs and file dumps pile up after they stop being relevant. So CacheLane tracks how many turns each block goes untouched, and once a block has been idle for **K turns** (default `K = 3`) it swaps the full content for a tiny **stub**:

```
Claude Code sends:   [ ...history... ][ 5,000-token file ][ new msg ]
                                        |  idle for K turns
                                        v  CacheLane substitutes (forwarded copy only)
Anthropic receives:  [ ...history... ][ stub: id + summary + expand() ][ new msg ]
```

K-pruning is **lossless and metadata-only**. Claude Code still holds the original and re-sends it every turn; CacheLane just masks it in the copy forwarded to Anthropic. If the model needs it back, it calls the `cachelane_expand` MCP tool, CacheLane flips that block from "stub" to "live", and the real content flows through again on the next turn. (Expanding is far cheaper than re-reading the file from scratch: the call carries just a block id, and it re-uses the existing cache entry instead of paying a fresh `1×` read **plus** a `1.25×` cache write for newly-read content.)

### 7. Why there's a database

Placing breakpoints on one request needs no memory, but pruning and restoring are stateful across turns. So CacheLane keeps a local SQLite database (`~/.cachelane/cachelane.db`) holding metadata:

- **Idle counters:** "this block has been untouched for 3 turns" is impossible to know without history.
- **Stub state and refetch handles:** which blocks are currently masked, and how `cachelane_expand` puts them back.
- **Prefix hashes:** to confirm the stable region really stayed byte-identical (so the cache will hit) and to detect drift.
- **Keepalive state:** which sessions are idle and how big their prefix is.
- **Stats:** token counts, hit ratios, and savings that power `cachelane stats`, `sessions`, and `explain`.
- **Optional retained originals:** only when `compression.retention.enabled` is explicitly enabled, CacheLane may store original tool outputs locally so Claude can retrieve them through `cachelane_retrieve_tool_output`.

By default CacheLane does not store prompts, code, or tool-output bodies. Enabling compression retention changes that privacy posture for tool outputs only; retained originals are scoped to the local workspace/session and expire according to `compression.retention.ttl_days`.

### 8. Keeping the cache warm (keepalive)

Anthropic's cache lives about 5 minutes by default; a 1-hour tier is available at 2× write cost ([Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)). If you step away mid-session, the cache would expire and your next turn would pay full price to re-seed it. So a keepalive worker sends a minimal synthetic ping (`max_tokens=1`) during idle gaps to keep the prefix hot, and CacheLane promotes large prefixes (≥ 50k tokens) to that 1-hour tier automatically.

---
