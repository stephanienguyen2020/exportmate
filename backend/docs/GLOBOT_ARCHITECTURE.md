# Globot: architecture notes

Globot is a past winning project (Microsoft Imagine Cup), checked out locally at `~/projects/Globot` (commit `ab200cf`). It is a supply-chain disruption workspace for shipping operators: it spots a crisis (e.g. Red Sea attacks), compares reroute options, checks vessel documents, and asks a human to approve the recommendation.

These notes cover how it is built, where it uses Google AI, and what ExportMate can borrow.

## 1. Big picture

```text
React + Vite (map, agent feed, document upload)
        |  REST + one WebSocket (demo)
        v
FastAPI (one process, main.py)
   |-- /api/v2/demo          scripted crisis demo over WebSocket, human approval gate
   |-- /api/v2/maritime      vessels, routes, document upload + OCR, CrewAI checks, RAG search
   |-- /api/v2/visual-risk   Gemini Vision on satellite images
   |-- /api/v2/hedge         fuel / FX / freight hedging (plain Python maths)
   |-- /api/v2/market-sentinel  mock news signals picked by route
        |
   Postgres (vessels, routes, customers)   Chroma Cloud (regulations + uploaded documents)
        |
   Gemini 2.0 Flash, gemini-embedding-001 (Google AI Studio API key)
```

| Part | Tech |
| --- | --- |
| Frontend | React, Vite, Tailwind, shadcn/ui, Deck.gl map, Clerk auth |
| Backend | FastAPI, SQLAlchemy, Postgres, Docker (`uvicorn main:app`) |
| Agents | CrewAI 1.7 (sequential crews of 3 to 5 agents) |
| LLM | Gemini 2.0 Flash first, OpenAI `gpt-4o-mini` as fallback, Ollama default for the old chatbot |
| Vector store | Chroma Cloud through LangChain, Gemini embeddings, cross-encoder reranker |
| Hosting | Dockerfile only; no cloud deploy config in the repo |

## 2. Where Google AI is used

All calls use the **Google AI Studio API** (`generativelanguage.googleapis.com`) with `GOOGLE_API_KEY`, not Vertex AI.

| Feature | File | Google service | What it does |
| --- | --- | --- | --- |
| Satellite risk check | `services/visual_risk_service.py` | Static Maps API + Gemini 2.0 Flash (vision) | Downloads a 640×640 satellite tile for a lat/lon, sends it to Gemini with a prompt, and gets JSON back with `risk_type`, `severity`, `affected_ports` and `recommendations`. |
| Document OCR | `services/ocr_service.py` | Gemini 2.0 Flash (vision, PDF/PNG/JPG) | Sends the uploaded certificate inline (base64) and asks for JSON fields: vessel name, IMO number, issue/expiry date, issuing authority, document number. |
| Embeddings | `services/maritime_knowledge_base.py` | `models/gemini-embedding-001` via `langchain-google-genai` | Embeds regulations (5 collections: IMO conventions, PSC, ports, regional, customs) and the user's uploaded documents into Chroma. |
| Agent brain | `core/crew_*.py` | `LLM(model="gemini/gemini-2.0-flash")` in CrewAI | Every crew agent runs on Gemini. A `generate_content("ping")` health check runs first; if Gemini fails (e.g. quota), it switches to OpenAI. |

Example satellite result (also the demo fallback):

```json
{"risk_type": "canal_blockage", "severity": 0.95,
 "affected_ports": ["Port Said (Egypt)", "Rotterdam (Netherlands)"],
 "recommendations": ["Immediate route diversion via Cape of Good Hope (+10-14 days)"]}
```

Gemini settings for vision: `temperature: 0.2`, `responseMimeType: "application/json"` (JSON mode, without a schema).

## 3. Agent workflows (the real ones)

Three CrewAI crews. Each one runs its tasks **in order**, and each task's output is passed to the next. Every agent gets the same "rules" text in its backstory: cite the regulation, tag MANDATORY/RECOMMENDED/CONDITIONAL, give a confidence level, and stay within a word limit.

### 3.1 Route compliance check (5 agents)
`core/crew_maritime_compliance.py`

```text
Regulation Researcher -> Port Specialist -> Document Analyst -> Risk Officer -> Report Writer
 (IMO, PSC regime)       (per-port docs,     (valid / expired /   (risk 0-100,     (JSON + exec
  tools: RAG search)      ECA, notice hrs)    missing)             priorities)      summary)
```

### 3.2 Document analysis (3 agents)
`core/crew_document_agents.py`, `POST /api/v2/maritime/documents/analyze`

Document Analyzer (classifies OCR text) → Requirements Researcher → Gap Analyst.

### 3.3 Missing-document detection (3 agents), the most interesting one
`core/crew_missing_docs_workflow.py`, `POST /api/v2/maritime/documents/detect-missing`

```text
1. Route Requirements Analyst   tool: requirements_lookup
   "Vessel: container, flag Panama, route CNSHA -> SGSIN -> NLRTM"
   -> 14 required documents (US docs only if the route has a US port)

2. Gap Detector                 tool: document_comparison
   -> "Safety Management Certificate: MISSING"

3. Semantic Verifier            tool: semantic_document_search (one batch call)
   searches the user's uploaded docs by meaning
   -> found "ISM_SMC_Certificate.pdf", distance 0.41 <= 0.6, same canonical type
   -> moves it from missing to valid and recalculates the score
```

The third agent exists because step 2 compares names, and names don't match ("SMC" vs "Safety Management Certificate"). The tool only accepts a match if **both** the embedding distance is ≤ 0.6 **and** the keyword classifier gives the same canonical type, which cuts out false matches.

### 3.4 Tools
CrewAI `BaseTool` classes in `core/maritime_tools.py` (`maritime_regulations_search`, `port_info`, `document_check`, `route_analysis`) and `core/document_tools.py` (`document_classifier`, `metadata_extractor`, `requirements_lookup`, `semantic_document_search`, `document_comparison`). Tools return JSON strings. Search tools are scoped with a Chroma `where` filter (`vessel_id` or `customer_id`).

### 3.5 Upload pipeline

```text
upload PDF -> save to disk -> Gemini OCR (JSON fields)
           -> if type is "other": keyword classifier, then semantic classifier
           -> store OCR text + flat metadata in Chroma `user_documents` (embedded)
```

## 4. The demo (what the judges saw)

`/api/v2/demo/ws` streams a ~75 s crisis story over a WebSocket. **Most of it is scripted**: the reasoning steps, debate and execution come from `demo/cot_data.py`. Only the satellite step calls Gemini for real.

| Event type | Content |
| --- | --- |
| `STATE_UPDATE`, `ALERT` | Normal state, then a "black swan" alert |
| `VISUAL_RISK_START` / `RESULT` | **Real** Gemini Vision call on the Suez tile (falls back to mock) |
| `COT_STEP` + `RAG_CITATION` | 10 agent steps (Market Sentinel → Risk Hedger → Logistics → Compliance → Adversarial), each with confidence and sources |
| `DEBATE_CHALLENGE` / `RESPONSE` / `RESOLVE` | An "Adversarial" agent challenges assumptions, e.g. "Cape route fuel cost ignores +18% South African bunker premium" |
| `DECISION_READY`, `AWAITING_CONFIRMATION` | Recommendation with options: One-Click Confirm / View Details / Human Override |
| (client sends `{"action":"confirm"}`) | Server waits on an `asyncio.Event` until a human clicks |
| `EXECUTION_STEP`…, `DEMO_COMPLETE` | Animated execution: notify carriers, update insurance, and so on; "Savings $112,500" |

Note: the scripted steps are labelled `"azure_service": "Azure OpenAI GPT-4-Turbo"` / `"Azure AI Search"` for the Imagine Cup, but no Azure code exists. The live AI is Gemini. The market-sentinel signals are mocks chosen by route (Shanghai→Rotterdam always returns the Red Sea crisis).

## 5. What made it win (design, not code)

1. **One clear story in 75 seconds**: crisis → evidence → debate → human approves → result in dollars.
2. **Visible agents**: every step shows which agent, its confidence, and its sources. The debate shows the system checking itself.
3. **Human approval gate** is part of the protocol (the server blocks until confirm), not just a button.
4. **Multimodal wow moment**: a real satellite image analysed live.
5. **Never breaks on stage**: every external call (Gemini, Maps, CrewAI) has a mock fallback.
6. **Numbers come from code**: hedging VaR and exposure are plain Python (`core/hedging_strategies.py`), not LLM output.

## 6. What ExportMate can borrow

| Idea | Globot | For ExportMate |
| --- | --- | --- |
| Gemini document extraction | OCR → JSON fields | Extract certificate of origin / FSC / phytosanitary fields (number, issuer, expiry, HS code) from uploads. Use Vertex `responseSchema` (stricter than plain JSON mode). Fits the "document extraction" item in `BACKEND_PLAN.md`. |
| Semantic verifier step | Re-checks "missing" docs by embedding search before reporting | Before marking an order `exposed` for a missing document, search the company's uploaded docs. Our rule "missing data → `needs_data`, not `clear`" stays. |
| Embedding + type check | distance ≤ 0.6 **and** same canonical type | Same double check when matching docs or HS codes, so one weak signal can't decide alone. |
| Adversarial challenge | Scripted debate on cost assumptions | Our auditor already checks citations. Add one "challenge the assumption" pass on the cost step (e.g. "USD 200/day delay: where from?"). |
| Typed event stream | `COT_STEP`, `DEBATE_*`, `AWAITING_CONFIRMATION` | Our `/api/chat` already streams NDJSON steps. Reuse the shape for the analysis run in phase 2 (Cloud Tasks job + progress events). |
| Decision record | `DecisionRecord(human_approval_required=True)` | Store each recommendation with its evidence and who approved it; links to our audit log. |
| Reranker after vector search | Cross-encoder `ms-marco-MiniLM-L-6-v2` | Option if Firestore vector search returns weak top results; Vertex AI Ranking API is the managed Google equivalent. |
| Vision on images | Satellite tiles | Lower priority. Could read photos of labels/stamps on documents. |
| Demo fallback | Mock result on any failure | Useful for the pitch, but label it in the UI ("sample data") so we don't present fixtures as live. |

## 7. What not to copy

| Globot does | Do instead |
| --- | --- |
| API key in the URL (`?key=...`), AI Studio API | Vertex AI with the Cloud Run service account (what `ai/server` already does) |
| `generate_content("ping")` before every crew run | Handle the error on the real call; a ping costs a request and adds latency |
| Parse output with `find('{')` … `rfind('}')` | Structured output (`responseSchema`) + pydantic validation |
| 5 agents in sequence for one check | Few steps, plain code where possible; each LLM call adds seconds and cost |
| `allow_origins=["*"]`, upload route without auth, `vessel = 1` when the vessel isn't found | Company-scoped routes as in our backend (`ViewerContext`, 404 for other companies) |
| Hard-coded debug log paths (`/Users/timothylin/...`) left in production code | Normal logging with request IDs |
| Scripted steps labelled as real Azure services | Label demo data honestly |
| Document metadata kept only in Chroma (no SQL table) | Postgres row per document (with `company_id`); vector store holds only the embeddings |

## 8. Files worth reading

| File | Why |
| --- | --- |
| `backend/core/crew_missing_docs_workflow.py` | Best agent design: requirements → gaps → semantic verify |
| `backend/core/document_tools.py` (`SemanticDocumentMatchTool`) | Batch tool with double-check matching |
| `backend/services/ocr_service.py` | Gemini document extraction prompt |
| `backend/services/visual_risk_service.py` | Gemini Vision + Static Maps, JSON mode |
| `backend/demo/autoplay_controller.py` | Event stream + human approval wait |
| `backend/core/reasoning_schemas.py` | `ActivityStep` / `DecisionRecord` shapes |
| `frontend/src/components/AgentCoTPanel.tsx`, `DebateView.tsx` | How the agent feed and debate are shown |
