import { z } from "zod";
import { db, nowIso, withImmediateTransaction } from "./db.js";
import { IdentityError } from "./identity.js";
import { createNotification } from "./mailer.js";
import { terminalHelpCodes, terminalHelpOutcomes, terminalHelpText, terminalHelpOutcome, type TerminalHelp } from "../src/shared/terminal-help.js";

export const terminalHelpReport = z.object({ events: z.array(z.object({
  eventId: z.string().uuid(), revision: z.number().int().min(1).max(2147483647),
  code: z.enum(terminalHelpCodes), scope: z.string().max(128).regex(/^[A-Za-z0-9_.@$:-]*$/),
  outcome: z.enum(terminalHelpOutcomes), status: z.enum(["OPEN", "RESOLVED"]),
  severity: z.enum(["GENERAL", "URGENT"]).optional(),
  logPath: z.string().max(512).regex(/^\/[A-Za-z0-9_./-]+$/),
}).strict()).min(1).max(16) }).strict();

export function terminalHelpList(terminalId: string): TerminalHelp[] {
  return db.prepare(`SELECT h.event_id AS eventId,h.code,h.scope,h.outcome,h.log_path AS logPath,
    h.opened_at AS openedAt,h.acknowledged_at AS acknowledgedAt,h.status,h.severity,
    h.resolved_at AS resolvedAt,h.resolution_source AS resolutionSource,u.display_name AS resolvedByName
    FROM terminal_help_requests h LEFT JOIN users u ON u.id=h.resolved_by
    WHERE h.terminal_id=? ORDER BY (h.status='OPEN') DESC,
      CASE WHEN h.status='OPEN' AND h.severity='URGENT' THEN 1 ELSE 0 END DESC,
      COALESCE(h.resolved_at,h.opened_at) DESC,h.event_id LIMIT 4096`).all(terminalId) as TerminalHelp[];
}

function notifyManagers(machineId: string, event: z.infer<typeof terminalHelpReport>["events"][number], resolved: boolean) {
  const managers = db.prepare(`SELECT DISTINCT u.id,COALESCE(ep.administration_updates,1) AS email
    FROM users u LEFT JOIN user_email_preferences ep ON ep.user_id=u.id
    WHERE u.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM deleted_user_tombstones d WHERE d.user_id=u.id)
    AND EXISTS(SELECT 1 FROM machine_admins a WHERE a.machine_id=? AND a.user_id=u.id)`).all(machineId) as {id:string;email:number}[];
  const recipients = managers.length ? managers : db.prepare(`SELECT u.id,COALESCE(ep.administration_updates,1) AS email
    FROM users u LEFT JOIN user_email_preferences ep ON ep.user_id=u.id WHERE u.role='SYSTEM_ADMIN' AND u.status='ACTIVE'
    AND NOT EXISTS(SELECT 1 FROM deleted_user_tombstones d WHERE d.user_id=u.id)`).all() as {id:string;email:number}[];
  const machine = db.prepare("SELECT name FROM machines WHERE id=?").get(machineId) as {name:string};
  const title = resolved ? "公钥同步求助已解除" : "公钥同步需要管理员处理";
  const detail = `${machine.name}${event.scope ? ` / ${event.scope}` : ""}：${terminalHelpText(event.code)} ${terminalHelpOutcome(event.outcome)}`;
  for (const recipient of recipients) createNotification(recipient.id, resolved ? "TERMINAL_HELP_RESOLVED" : "TERMINAL_HELP", title,
    resolved ? `${machine.name}：终端已确认此前问题解除。` : detail, `/admin/machines/${machineId}/info`, {
      emailPolicy: event.severity === "URGENT" && recipient.email ? "REQUIRED_ACTION" : "NONE", entity: {type:"terminal_help",id:event.eventId},
    });
}

export function receiveTerminalHelp(terminalId: string, machineId: string, report: z.infer<typeof terminalHelpReport>) {
  return withImmediateTransaction(() => {
    for (const input of report.events) {
      // Older terminals omit severity. Incomplete recovery is urgent; ordinary
      // enrollment/configuration problems remain general reports.
      const event = {...input, severity: input.severity ?? (input.outcome === "RECOVERY_REQUIRED" ? "URGENT" : "GENERAL")};
      const old = db.prepare("SELECT * FROM terminal_help_requests WHERE terminal_id=? AND event_id=?").get(terminalId,event.eventId) as
        {revision:number;code:string;scope:string;outcome:string;status:string;log_path:string;severity:string} | undefined;
      if (old && (old.code !== event.code || old.scope !== event.scope)) throw new IdentityError("求助事件与原记录不一致",409);
      if (old && event.revision <= old.revision) continue;
      // A resolved event is a tombstone: delayed requests must never reopen it.
      if (old?.status === "RESOLVED") continue;
      const now = nowIso();
      if (!old) {
        const count = db.prepare("SELECT COUNT(*) AS n FROM terminal_help_requests WHERE terminal_id=?").get(terminalId) as {n:number};
        const active = db.prepare("SELECT COUNT(*) AS n FROM terminal_help_requests WHERE terminal_id=? AND status='OPEN'").get(terminalId) as {n:number};
        if (count.n >= 4096 || (event.status === "OPEN" && active.n >= 128)) throw new IdentityError("终端求助记录数量超限，请联系管理员",409);
        db.prepare(`INSERT INTO terminal_help_requests(terminal_id,event_id,revision,code,scope,outcome,log_path,status,opened_at,updated_at,severity,resolved_at,resolution_source)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(terminalId,event.eventId,event.revision,event.code,event.scope,event.outcome,event.logPath,event.status,now,now,event.severity,event.status==='RESOLVED'?now:null,event.status==='RESOLVED'?'MACHINE':null);
      } else db.prepare(`UPDATE terminal_help_requests SET revision=?,outcome=?,log_path=?,status=?,updated_at=?,severity=?,resolved_at=?,resolution_source=?,
          acknowledged_at=CASE WHEN outcome<>? THEN NULL ELSE acknowledged_at END WHERE terminal_id=? AND event_id=?`)
        .run(event.revision,event.outcome,event.logPath,event.status,now,event.severity,event.status==='RESOLVED'?now:null,event.status==='RESOLVED'?'MACHINE':null,event.outcome,terminalId,event.eventId);
      const resolved = event.status === "RESOLVED";
      if ((!old && !resolved) || (old && (resolved || (event.severity === "URGENT" && old.severity !== "URGENT")))) notifyManagers(machineId,event,resolved);
    }
    return { accepted: report.events.map(({eventId,revision}) => ({eventId,revision})) };
  });
}
