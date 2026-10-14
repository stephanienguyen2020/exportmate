# ExportMate — site and account flow

## Scope
Extend the existing frontend, keeping the restrained green-and-paper visual language. Replace landing dialogs with scroll-linked sections. Keep copy short: a clear heading, one sentence, one action. Each section has its own composition, photography, and spatial motion.

## Public site
| Route / section | Purpose | Interaction |
| --- | --- | --- |
| `#/` | Reference-style hero | Demo entry, account entry, pointer tilt |
| `#/?section=how` | How it works | Scroll-linked steps, 3D document stack, port photograph |
| `#/?section=about` | About | Workshop photograph, parallax layers, physical shipping-label treatment |
| `#/?section=contact` | Contact | Telephone photograph, 3D postcard, local inquiry draft |
| `#/privacy` | Prototype privacy information | Describe actual local storage and external asset requests |
| `#/terms` | Prototype terms/status | Clear demo boundaries; no invented production policy |
| Unknown route | 404 | Return home |

## Account flow to implement
| Route | UI and transition |
| --- | --- |
| `#/login` | Email/password validation, password visibility, demo sign-in, recovery and signup links |
| `#/signup` | Name/email/password validation and consent → email-verification preview |
| `#/verify-email` | Pending verification UI; explicit preview verification → onboarding |
| `#/forgot-password` | Email entry → reset-request preview |
| `#/check-email` | No-email-sent notice; open reset preview |
| `#/reset-password` | Matching new-password validation → reset-complete confirmation |
| `#/onboarding` | Three steps: company, role/corridor, review → workspace |
| `#/workspace/account` | Profile, company and notification preferences; browser-local save |
| `#/logout` | Clear demo session → signed-out screen; retain saved workspace data |

## Existing workspace
Overview, orders/detail, rule watch, data room and playbook stay functional. Add account navigation and a visible sign-out action. Anonymous workspace access goes through login; demo entry explicitly creates a browser session. Preserve a valid intended workspace route through login.

## Frontend behavior
This is an **account-flow prototype**, not an authentication server. Valid forms advance a clearly labeled demo session. Never store passwords or log them. Store only non-sensitive demo profile/preferences in local storage and session state in session storage. Verification and password recovery are explicit previews; no emails are sent and no tokens are verified. Contact submission saves a local inquiry draft, not a delivered message. Drafts can be cleared. Do not use real credentials or sensitive information.

## Backend work needed
Use the authentication and tenant membership design in `backend/docs/BACKEND_PLAN.md`. Replace the demo adapter with verified login/signup, rate limiting, expiring one-time verification/reset tokens, session revocation, tenant authorization, account updates and validated contact delivery. Implement email verification before tenant creation. Do not treat the client route gate as security. Draft legal pages must be replaced with reviewed policies before launch.

## Acceptance
- All three public links navigate to real sections; no landing dialogs.
- Each section has distinct visuals; motion respects reduced motion and touch devices.
- Login/signup validation, password reveal, verification preview, reset preview, onboarding, account save and sign-out are connected.
- Back/reload/direct-link behavior is sensible; invalid routes show 404.
- No passwords persisted; demo status and undelivered messages remain explicit.
- Responsive layouts and existing workspace navigation remain intact.
