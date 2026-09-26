# reasoning_effort: what the tiers actually do

## The tiers are names, not numbers

The OpenAI-compatible field is a string:

```
none | low | medium | high | xhigh | max
```

What each one *means* is entirely up to the upstream. This is not a standard
scale, and gateways differ in three ways that all matter:

1. **Which values they accept.** Many validate strictly and return
   `400 ... value '<x>' is invalid`. One real gateway accepted all six of the
   above but rejected `off`, `disabled`, `EXTRA_HIGH`, `extra_high` and `1`.
2. **How they map a value onto their vendor's own scale.** A gateway in front of
   several vendors may clamp `xhigh` down to the vendor's `high`, and may map
   `medium` somewhere you would not guess.
3. **What "no parameter at all" means.** This is the interesting one.

## "default" is a state, not a value

There is no `default` tier. If you want the provider's own default behaviour, you
send **nothing** — the request simply omits `reasoning_effort`. That is what this
proxy does when a tier is `null`, `""` or `"default"`.

This matters because a provider's default is frequently *not* equal to any tier
you could name. In one measurement on a real gateway:

| model | no parameter (provider default) | `max` |
|---|---|---|
| strongest coding model | 813 / 909 reasoning tokens | **840 / 2312** |
| a cheaper flash model | **2764 / 4020** | 2160 / 1980 |

Same task, two runs each. On the first model `max` clearly raises the thinking
budget; on the second the *provider default* is the strongest setting available,
and `max` actually thinks **less**. So:

* do not assume `max` ≥ provider default;
* for a model whose default is already aggressive, exposing "no parameter" as a
  tier is genuinely useful, not a cop-out.

## The trap: `none` is not "default"

On the same gateway, `none` silently **disabled thinking** on 3 of 5 models, and
those models then answered a reasoning question **incorrectly**. If you want
"whatever the provider does by default", use `null`. Reserve `none` for when you
genuinely want no thinking.

## How to measure your own gateway

Run 2–3 samples per tier on a task that needs real reasoning, and compare
`usage.completion_tokens_details.reasoning_tokens`:

```bash
# no parameter (provider default)
curl -s $UPSTREAM/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"<id>","messages":[{"role":"user","content":"<hard question>"}],"max_tokens":2048}' \
  | jq '.usage.completion_tokens_details'

# explicit tier
curl -s $UPSTREAM/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"<id>","reasoning_effort":"max","messages":[…],"max_tokens":2048}' \
  | jq '.usage.completion_tokens_details'
```

Practical notes:

* **Raise `max_tokens`.** At `max` some models spend the entire budget thinking
  and never emit an answer; that shows up as empty content with
  `reasoning_tokens` equal to the cap.
* **Expect noise.** Reasoning-token counts vary a lot between runs. Do not draw a
  conclusion from a single pair; treat anything within ~20% as "the same".
* **A wrong answer is a signal.** If a low tier produces a confidently wrong
  result on a question the model gets right at a higher tier, that is more
  meaningful than a token count.
* Check whether `reasoning_content` (a separate stream field) carries text the
  models keep out of `content`. Some vendors stream their thinking there and put
  the answer there too.

## When the database is the only place

If your client stores per-model config in a local SQLite database, you may be
tempted to patch it. Two warnings from experience:

1. **The app may rewrite it.** One client reloads its model list from its own
   server on a timer (observed: a forced refresh at startup, then every 1–7
   minutes). Any edit was gone within minutes, while other keys it never touches
   survived — which is exactly how you prove the app is the thing overwriting
   you.
2. **The value may not be contiguous on disk.** A large JSON value can span
   SQLite overflow pages, so "find the bytes and replace them" is wrong even when
   the sizes match. Never hand-edit a database file: use a real SQLite client, or
   don't edit it at all.

Both are reasons to prefer moving the network endpoint over moving the storage.

## A note on `reasoning_effort` vs `reasoning_effort_level`

Some clients use a *different* field for their own models
(`reasoning_effort_level`) than for external/custom ones (`reasoning_effort`).
If you are patching a client rather than proxying it, make sure you are writing
the field the client actually sends for your kind of model. A proxy avoids the
question entirely, because you control the outgoing request.
