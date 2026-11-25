// The assistant in the demo: a demo visitor (their sandbox, backend services/demo.py) or anyone
// signed out may ask only these questions, answered from the demo's data. Asking their own
// questions needs an account. The chat offers them as suggestions to everyone (GET /api/chat/questions).
export const DEMO_QUESTIONS = Object.freeze([
  "Which orders need action, and why?",
  "What did the latest news scan flag?",
  "Which stock items have no origin trace on file?",
  "How do I import my orders?",
]);

export const DEMO_NOTE = "In the demo you can ask the questions above. Sign in or create an account to ask your own.";

/** `company` is GET /api/v1/company/knowledge's data, or null when signed out. */
export const inDemo = (company) => !company || Boolean(company.company?.demoExpiresAt);

/** True when every question the user asked is one of the demo's. */
export const demoQuestionsOnly = (messages) =>
  messages.filter((m) => m.role === "user").every((m) => DEMO_QUESTIONS.includes(m.text.trim()));
