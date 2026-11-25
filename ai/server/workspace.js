// Whose data a chat turn answers from: one value, built once by each entry point (index.js,
// runtime.js, eval/run.js), so runAgent can't be handed a mix that means nothing (a company
// with the demo's orders, a backend reader without a company).
//
//   { kind: "company", company, access, user, backend }  a signed-in member of `company`
//   { kind: "demo", demo, access }                        the browser demo, its orders sent along
//   { kind: "anonymous", access }                         no company and no demo orders
//
// `access` says which news sources the turn sees (access.js); `backend` GETs a company backend
// path with the member's own token; `user` ({ id }) owns the turn's session and memories.
import { ANONYMOUS } from "./access.js";

/**
 * A turn's workspace from the fields a chat request carries. A company turn never uses the
 * demo's orders, whatever the client sent; a turn with neither is anonymous.
 */
export function turnWorkspace({ company = null, access = null, user = null, backend = null, demo = null } = {}) {
  if (company)
    return Object.freeze({
      kind: "company",
      company,
      access: access ?? { companyId: company.company.id, disabled: [] },
      user,
      backend,
    });
  if (demo?.orders || demo?.playbook) return Object.freeze({ kind: "demo", demo, access: ANONYMOUS });
  return ANONYMOUS_WORKSPACE;
}

export const ANONYMOUS_WORKSPACE = Object.freeze({ kind: "anonymous", access: ANONYMOUS });
