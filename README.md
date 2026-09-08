<div align="center">

# nearcall

**Keep the call local. Pay only when you cannot.**

An OpenAI-compatible router that sends requests to whatever you have running on your own machine, and reaches a paid API only when nothing local can serve them.

[![CI](https://github.com/catidegla/nearcall/actions/workflows/ci.yml/badge.svg)](https://github.com/catidegla/nearcall/actions/workflows/ci.yml)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

```bash
npx nearcall serve
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
client.chat.completions.create(model="gpt-4o", messages=[...])
```

That request goes to Ollama. If Ollama is not running it goes to LM Studio, then llama.cpp, then to OpenAI only if you have a key set and nothing local could handle it. Your code does not change, and the response carries `x-nearcall-backend` so you always know where it went.

## Why not LiteLLM

LiteLLM is a good gateway and it is built for a platform team: a Python service, a large dependency tree, a config file before it does anything useful. If you are one developer with Ollama on your laptop and a cloud key for the hard cases, that is a lot of machinery for a routing decision.

nearcall is **one command, zero dependencies, and works before you write any config.** It also does one thing LiteLLM does not: it tells you *why*.

## It explains itself

```bash
$ nearcall route "$(cat long-document.txt)" --model gpt-4o

  request  47200 tokens, model gpt-4o

   x ollama       ollama has a 32000 token window and this request needs about 47200
   x lmstudio     lmstudio has a 8000 token window and this request needs about 47200
   x llamacpp     llamacpp has a 8000 token window and this request needs about 47200
  -> openai       no local backend could serve this request

  remote, about $0.2360 for this request
```

Nothing is sent. This is the decision the router would make, and the reasoning behind it.

A router that quietly sends your request to a paid API and bills you for it is worse than no router, so every decision carries its trace. The same trace appears in the `503` body when nothing can serve a request, instead of a bare "no backend available".

## What you saved

```bash
$ curl -s localhost:8787/stats | jq
{
  "requests": 412,
  "localRequests": 389,
  "remoteRequests": 23,
  "localShare": 0.944,
  "spent": 0.412,
  "saved": 6.183,
  "backends": [
    { "name": "ollama", "local": true,  "requests": 389, "cost": 0, "averageLatencyMs": 1840 },
    { "name": "openai", "local": false, "requests": 23,  "cost": 0.412, "averageLatencyMs": 890 }
  ]
}
```

`saved` is priced against the **cheapest** cloud backend you have configured, not the most expensive. Charging the saving against the priciest model you happen to have set up would inflate the number, and a savings counter nobody believes is worth less than none.

## Routing

In order:

1. **An explicit `x-nearcall-backend` header** wins over everything, including health. If you ask for a specific backend you usually know something the router does not.
2. **Anything that cannot serve the request is ruled out.** Context window too small, no tool support, no vision support, over your per-request budget, unhealthy, or disabled.
3. **Local before remote.** Deliberately ahead of latency: a local model that takes two seconds still beats a cloud model that takes one and charges for it. That is the whole reason you installed this.
4. **Then priority, then cost, then observed latency.**

`supportsVision` is opt-in. A backend that does not declare it is assumed not to have it, because silently dropping an image produces a confidently wrong answer rather than an error.

### Failure handling

A backend that passes a health probe can still fail a completion, so a failed request walks down the ranked fallback list.

**Only transport failures and `5xx` responses trigger a fallback.** A `400` means the request itself is malformed, and sending it on to a second, paid backend would turn a client bug into a bill.

Health needs two consecutive failures before a backend is marked down. One refused connection while a model reloads should not divert your session to a paid API.

## Configuration

None required. The defaults cover Ollama, LM Studio and llama.cpp on their documented ports, plus any cloud provider whose key is in your environment.

```jsonc
// nearcall.config.json
{
  "port": 8787,
  "preferLocal": true,
  "maxCostPerRequest": 0.05,
  "backends": [
    {
      "name": "ollama",
      "local": true,
      "baseUrl": "http://127.0.0.1:11434/v1",
      "models": { "gpt-4o": "qwen3:8b", "*": "qwen3:8b" },
      "contextWindow": 32000,
      "supportsTools": true
    },
    {
      "name": "openai",
      "local": false,
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "contextWindow": 128000,
      "supportsVision": true,
      "pricing": { "inputPerMillion": 2.5, "outputPerMillion": 10 }
    }
  ]
}
```

The `models` map translates names, so your code can keep asking for `gpt-4o` while a local model answers it.

A config file **replaces** the default backends rather than merging with them, so what you write is the complete picture rather than something layered on top of defaults you cannot see. Unknown options are rejected by name, because a silently ignored `prefrLocal` is a bad afternoon.

Keys are read from the environment at call time and never stored in config.

## Commands

```
nearcall serve                start the OpenAI-compatible server
nearcall route <prompt>       show where a request would go, and why, without sending it
nearcall doctor               probe every configured backend
nearcall models               list models across healthy backends
nearcall config               print the resolved configuration
```

`doctor` is the one to run first:

```
$ nearcall doctor

  down ollama       http://127.0.0.1:11434/v1     fetch failed
  down lmstudio     http://127.0.0.1:1234/v1      fetch failed
  down llamacpp     http://127.0.0.1:8080/v1      fetch failed

  No local backend is answering.
  Start one, for example "ollama serve", or every request will go to a paid API.
```

## Endpoints

| | |
| :--- | :--- |
| `POST /v1/chat/completions` | Routed and proxied, streaming supported |
| `POST /v1/embeddings` | Routed and proxied |
| `GET /v1/models` | Aggregated across healthy backends, each tagged local or remote |
| `GET /health` | Per-backend health and observed latency |
| `GET /stats` | Requests, tokens, spend and savings |

## What has and has not been verified

41 tests, run on Linux, macOS and Windows. The end-to-end tests stand up real HTTP servers rather than stubbing `fetch`, because the parts most likely to break are the ones a stub hides: streaming, header propagation, and falling back after an upstream returns `500`.

**It has not yet been run against a live Ollama or LM Studio.** The backends in the test suite are mocks that speak the OpenAI wire format, which is the right way to test routing deterministically, but it is not the same as a real model server with real timing. If you run it against one, an issue describing what broke is the most useful thing you could send.

## Contributing

```bash
npm test    # 41 tests, nothing to install
```

New backends go in `src/config.mjs`. The router in `src/router.mjs` is pure, so a routing change is testable without standing up four model servers, and it should stay that way.

## License

[MIT](LICENSE)
