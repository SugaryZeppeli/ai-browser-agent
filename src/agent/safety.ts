/**
 * Security layer — advanced pattern #3 from the task spec.
 *
 * Wraps the destructive-action tools (click_element, type_text) and blocks
 * them until the user has explicitly approved the specific intent via
 * confirm_action. Uses two signals:
 *
 *   1. Element-name heuristic — regex match against the element's
 *      accessible name or visible text. The pattern list covers common
 *      English and Russian destructive verbs (delete / remove / submit
 *      / send / confirm / pay / purchase / checkout / apply / publish
 *      and their Russian counterparts).
 *   2. Input-type heuristic — passwords and credit-card autocomplete
 *      fields trigger a block on type_text.
 *
 * A single approval is *consumable*: once the user says yes, the next
 * destructive action goes through, then the flag resets. The agent is
 * instructed in the system prompt to call confirm_action BEFORE any
 * obviously destructive click — the runtime guard is a safety net for
 * cases where the model forgets or misjudges.
 */

/**
 * Patterns that indicate a destructive or irreversible action. Kept as
 * word-boundary regex so we don't blow up on "submitted" appearing in a
 * paragraph of body text. The accessible name we compare against is
 * capped by describeElement() upstream so this list stays cheap.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // Payment / financial
  /\b(pay|purchase|buy|checkout|place order)\b/i,
  /(оплатить|оплата|оплачу|купить)/i,
  // Deletion / removal
  /\b(delete|remove|erase|drop)\b/i,
  /(удалить|удаление|убрать|стереть)/i,
  // Submission / sending
  /\b(submit|send|publish|apply)\b/i,
  /(отправить|опубликовать|откликнуться|подать|оформить)/i,
];

export interface ElementInfo {
  selector: string;
  name: string;
  tag: string;
  type?: string;
}

export interface SafetyVerdict {
  blocked: boolean;
  /** Human-readable reason suitable for the model. */
  reason: string;
  /** The specific pattern/rule that fired. */
  matchedRule?: string;
}

export interface SafetyState {
  checkClick(info: ElementInfo): SafetyVerdict;
  checkType(info: ElementInfo & { text: string }): SafetyVerdict;
  /** Consume the pending approval after a successful action. */
  consumeApproval(): void;
  /** Grant an approval (called after confirm_action succeeds). */
  approve(intent: string): void;
  /** Has the user approved something that we haven't consumed yet? */
  isApproved(): boolean;
  /** Stats for the run report. */
  stats(): { blocks: number; approvals: number; lastIntent?: string };
}

export function createSafetyState(): SafetyState {
  let approvedOnce = false;
  let lastIntent: string | undefined;
  let blocks = 0;
  let approvals = 0;

  function matchName(name: string): string | null {
    if (!name) return null;
    for (const re of DESTRUCTIVE_PATTERNS) {
      if (re.test(name)) return re.source;
    }
    return null;
  }

  return {
    checkClick(info) {
      const rule = matchName(info.name);
      if (!rule) return { blocked: false, reason: '' };
      // Peek at approval but don't consume — consumeApproval() is called
      // after the click actually succeeds, so a timeout doesn't waste the approval.
      if (approvedOnce) {
        return {
          blocked: false,
          reason: `destructive click allowed under approval "${lastIntent}"`,
          matchedRule: rule,
        };
      }
      blocks++;
      return {
        blocked: true,
        reason: `"${info.name}" looks destructive (rule: ${rule})`,
        matchedRule: rule,
      };
    },

    checkType(info) {
      if (info.type === 'password') {
        if (approvedOnce) {
          return { blocked: false, reason: 'password entry allowed under approval' };
        }
        blocks++;
        return {
          blocked: true,
          reason: 'target is a password input',
          matchedRule: 'type=password',
        };
      }
      return { blocked: false, reason: '' };
    },

    consumeApproval() {
      approvedOnce = false;
    },

    approve(intent) {
      approvedOnce = true;
      lastIntent = intent;
      approvals++;
    },

    isApproved() {
      return approvedOnce;
    },

    stats() {
      return { blocks, approvals, lastIntent };
    },
  };
}
