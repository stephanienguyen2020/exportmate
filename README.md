# ExportMate

A responsive trade-compliance frontend for small manufacturers, inspired by the supplied editorial design reference. Built with React, TypeScript, Vite, Lucide icons, and Papa Parse.

## Run

```sh
npm install
npm run dev
```

Open the local URL printed by Vite (normally http://127.0.0.1:5173). `npm run build` type-checks and produces `dist/`; `npm run preview` serves the production build. No environment variables or credentials are required for the prototype.

## Explore

The public landing at `#/` includes full How it works, About, and Contact sections with parallax photography and 3D layers. Account pages include `#/login`, `#/signup`, `#/verify-email`, `#/forgot-password`, `#/check-email`, `#/reset-password`, `#/onboarding`, and `#/logout`. Use the demo CTA to enter `#/workspace`; profile settings are at `#/workspace/account`. Forms are connected preview flows, not real authentication. No passwords are stored or emails sent.

- **Overview:** corridor snapshot, exposure metrics and prioritized action.
- **Orders:** search, status filters and order-impact detail.
- **Rule watch:** sample sources, before/after requirement and the simulated five-agent review.
- **Data room:** upload a CSV, inspect validation/preview, explicitly import; download a starter template.
- **Playbook:** add, toggle and delete browser-local policies.
- **Impact detail:** inspect cost assumptions and evidence; edit and confirm a simulated supplier message.

Use “See ExportMate in action” or “Run rule-change demo” to walk from clear seed orders to two exposures, including an auditor rejection. The demo resets seed risk flags and demo confirmations, preserving imported orders. Imported records remain “Awaiting analysis.”

The Maker/Buyer view switch illustrates separately seeded USD/SGD estimates. It is not tenant authorization or a currency conversion. All legal content is illustrative, and no external messages are sent.

Browser storage keys: `em-orders`, `em-rules`, `em-sent`, `em-profile`, `em-inquiry`; session storage: `em-session`, `em-next`. Clear those keys in browser developer tools to reset persisted prototype data. Browser storage is not suitable for sensitive production data.

## Planning documents

- [Page plan](docs/FRONTEND_PLAN.md)
- [Complete site and account flow](docs/ACCOUNT_AND_SITE_PLAN.md)
- [Landing design and artwork prompt](docs/LANDING_DESIGN.md)
- [Backend architecture and implementation checklist](docs/BACKEND_PLAN.md)

## Assets

Port photography: [Unsplash image](https://images.unsplash.com/photo-1578575437130-527eed3abbec), stored locally at `public/port.jpg`. DM Sans and DM Mono load from Google Fonts with system fallbacks. Icons: Lucide. The image is illustrative global-trade photography, not a claim that the depicted port is on the demo corridor.

## Scope

This delivery implements the frontend and backend plan. Authentication, live regulation crawling, Gemini/ADK execution, verified citations, document extraction, durable server storage and real notification delivery are described in the backend plan and are not implemented.
