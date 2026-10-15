# ExportMate — frontend gaps against the backend

Backend features that are built and tested but that the frontend doesn't use yet. Endpoint details are in [API.md](API.md); the rules behind them in [REQUIREMENTS.md](REQUIREMENTS.md).

As of 15 October 2026 every built endpoint has a screen (checked against `frontend/src`): analysis runs and reports, owner review and feedback, HS code suggestions, checked playbook rules, cost settings, supplier certificate upload, requirement drafting and review, supplier messages, the activity log and the contact form. API.md's table says where each one is called. Two read endpoints are deliberately unused: `GET /runs/{id}` (`POST /runs` returns the finished run) and `GET /supplier-messages/{id}` (the order's list has every message).

| # | Screen | Backend ready | Frontend today | To build |
| --- | --- | --- | --- | --- |
| 1 | **Supplier form: contact** | `contactName`, `contactEmail` on suppliers | In the trade map's supplier form | Remove this row once checked in the browser |

**Not frontend, still open:** the AI test set (REQUIREMENTS.md open question 22).

Add a row when a new endpoint ships without a screen; remove it once its screen uses the endpoint.
