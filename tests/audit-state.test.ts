import { afterEach, expect, it } from "vitest";
import { auditFilters, AuditRequestSequence, emptyAuditDraft } from "../src/audit-state";
import { setBeijingTimeMode } from "../src/date";
afterEach(() => setBeijingTimeMode(false));
it("converts inclusive calendar dates using the selected timezone", () => {
  setBeijingTimeMode(true);
  expect(auditFilters({...emptyAuditDraft,fromDate:"2026-09-07",toDate:"2026-09-07"})).toEqual({from:"2026-09-06T16:00:00.000Z",to:"2026-09-07T16:00:00.000Z"});
  expect(()=>auditFilters({...emptyAuditDraft,fromDate:"2026-09-08",toDate:"2026-09-07"})).toThrow();
  expect(()=>auditFilters({...emptyAuditDraft,fromDate:"2026-02-30"})).toThrow();
  setBeijingTimeMode(false);
  expect(auditFilters({...emptyAuditDraft,toDate:"2026-03-08"}).to).toBe(new Date(2026,2,9).toISOString());
});
it("invalidates out-of-order responses even if transport ignores abort, and on unmount", () => {
  const sequence=new AuditRequestSequence(); const first=sequence.begin(),second=sequence.begin();
  expect(first.signal.aborted).toBe(true);expect(first.current()).toBe(false);expect(second.current()).toBe(true);
  sequence.cancel();expect(second.current()).toBe(false);
});
