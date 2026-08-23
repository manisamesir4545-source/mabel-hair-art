const functionSource = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);
const policySource = await Deno.readTextFile(
  new URL("./template-policy.ts", import.meta.url),
);
const migrationSource = await Deno.readTextFile(
  new URL(
    "../../migrations/20260823033550_add_service_location_update_announcement.sql",
    import.meta.url,
  ),
);
const dynamicRecipientMigrationSource = await Deno.readTextFile(
  new URL(
    "../../migrations/20260823103804_refresh_current_announcement_recipients.sql",
    import.meta.url,
  ),
);
import {
  hashRecipientPhones,
  isRecipientHash,
  MAX_CURRENT_RECIPIENTS,
} from "./recipient-snapshot.ts";

function assertContract(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("address announcement runtime uses exactly one BODY parameter", () => {
  assertContract(
    policySource.includes(
      'ANNOUNCEMENT_TEMPLATE_NAME = "is_yeri_adres_guncellemesi";',
    ),
    "template name drifted",
  );
  assertContract(
    policySource.includes(
      '"Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir";',
    ),
    "address parameter drifted",
  );
  assertContract(
    functionSource.includes(
      "const TEMPLATE_PARAMETERS = Object.freeze([ANNOUNCEMENT_ADDRESS]);",
    ),
    "BODY parameter list is not the single frozen address value",
  );
  assertContract(
    !functionSource.includes("ANNOUNCEMENT_DATE") &&
      !functionSource.includes("customer_name"),
    "legacy date or customer-name parameter remains in the runtime",
  );
  assertContract(
    !functionSource.includes('type: "button"'),
    "static Maps button must not receive a runtime component",
  );
});

Deno.test("send path repeatedly enforces the exact template policy", () => {
  assertContract(
    policySource.includes('ANNOUNCEMENT_TEMPLATE_CATEGORY = "UTILITY";') &&
      policySource.includes('ANNOUNCEMENT_TEMPLATE_LANGUAGE = "tr";'),
    "required template category or language drifted",
  );
  assertContract(
    functionSource.includes("evaluateAnnouncementTemplate(approval).eligible"),
    "send endpoint does not use the exact component policy",
  );
  assertContract(
    functionSource.includes("canSend: templateEligible") &&
      functionSource.includes("canStartNewRound: templateEligible"),
    "status send flags do not depend on exact template eligibility",
  );
  assertContract(
    (functionSource.match(/getTemplateApproval\(TEMPLATE_NAME\)/g) || [])
          .length >= 3 &&
      functionSource.includes(
        'diagnosticStage = "preclaim_template_approval"',
      ) &&
      functionSource.includes("templatePolicyDriftError()"),
    "status, pre-claim, and per-batch template checks are not all present",
  );
});

Deno.test("migration copies only the frozen snapshot and preserves prior audit", () => {
  assertContract(
    migrationSource.includes("mabel_reopening_2026_08_18_v2") &&
      migrationSource.includes("mabel_is_yeri_adres_guncellemesi_v1"),
    "source or target announcement lineage drifted",
  );
  assertContract(
    migrationSource.includes("public.broadcast_suppressions suppressed"),
    "current suppressions are not removed from the new snapshot",
  );
  assertContract(
    !/from\s+public\.(?:app_state|appointments)\b/i.test(migrationSource),
    "migration reads a client-writable recipient source",
  );
  assertContract(
    !/(?:update|delete\s+from)\s+public\.(?:message_logs|broadcast_campaigns)\b/i
      .test(migrationSource),
    "migration mutates historical campaign or message audit rows",
  );
  assertContract(
    migrationSource.includes(
      "jsonb_build_array('Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir')",
    ),
    "campaign fingerprint does not contain the exact address parameter",
  );
});

Deno.test("recipient hash binds the canonical phone set, not input order", async () => {
  const first = await hashRecipientPhones(["905551111111", "905552222222"]);
  const reordered = await hashRecipientPhones(["905552222222", "905551111111"]);
  const replaced = await hashRecipientPhones(["905551111111", "905553333333"]);

  assertContract(first === reordered, "recipient hash is order-dependent");
  assertContract(
    first !== replaced,
    "same-count phone replacement was not detected",
  );
  assertContract(
    isRecipientHash(first),
    "recipient hash is not lowercase SHA-256 hex",
  );
  assertContract(
    !isRecipientHash(first.toUpperCase()) && !isRecipientHash(first.slice(1)),
    "recipient hash validator accepts a non-canonical value",
  );
  assertContract(MAX_CURRENT_RECIPIENTS === 1000, "recipient cap drifted");
});

Deno.test("current candidates preserve union, opt-out, dedupe, and suppression semantics", () => {
  for (
    const contract of [
      "public.app_state",
      "customerAccounts",
      "public.appointments",
      "whatsappOptOut",
      "marketingOptOut",
      "announcementOptOut",
      "whatsappConsent",
      "marketingConsent",
      "receiveWhatsappAnnouncements",
      "opted_out_phones",
      "distinct on (candidates.phone)",
      "public.broadcast_suppressions suppressed",
    ]
  ) {
    assertContract(
      dynamicRecipientMigrationSource.includes(contract),
      `current-candidate contract is missing ${contract}`,
    );
  }
  assertContract(
    dynamicRecipientMigrationSource.includes(
      "when account_raw.raw_phone like '00%'",
    ) &&
      dynamicRecipientMigrationSource.includes(
        "then '9' || account_without_00.phone",
      ) &&
      dynamicRecipientMigrationSource.includes(
        "then '90' || account_without_local_zero.phone",
      ),
    "phone normalization drifted from the original announcement semantics",
  );
  assertContract(
    !/=\s*163\b/.test(dynamicRecipientMigrationSource),
    "the observed 163-candidate preflight count was hard-coded",
  );
});

Deno.test("idle refresh is bounded and cannot rewrite an attempted audit round", () => {
  for (
    const guard of [
      "campaign.attempt_count = 0",
      "v_campaign.attempt_count <> 0",
      "from public.message_logs log",
      "campaign.state = 'idle'",
      "v_campaign.state <> 'idle'",
      "limit v_max_recipients + 1",
      "v_candidate_count > v_max_recipients",
      "v_account_count > 5000",
      "v_appointment_count > 10000",
      "pg_advisory_xact_lock",
    ]
  ) {
    assertContract(
      dynamicRecipientMigrationSource.includes(guard),
      `idle refresh safety guard is missing ${guard}`,
    );
  }
  assertContract(
    dynamicRecipientMigrationSource.includes(
      "greatest(\n      25,\n      ceil(v_campaign.recipient_count::numeric * 0.25)",
    ),
    "bounded growth check is missing",
  );
});

Deno.test("new rounds use current candidates and retain old campaign audit", () => {
  const prepareStart = dynamicRecipientMigrationSource.lastIndexOf(
    "create or replace function public.prepare_broadcast_round",
  );
  const prepareSource = dynamicRecipientMigrationSource.slice(prepareStart);
  assertContract(
    prepareStart >= 0,
    "prepare_broadcast_round redefinition is missing",
  );
  assertContract(
    prepareSource.includes(
      "public.get_current_service_location_broadcast_candidates()",
    ),
    "new round still does not use the current candidate union",
  );
  assertContract(
    !prepareSource.includes("v_series.seed_campaign_id") &&
      !prepareSource.includes("source.campaign_id = v_series.seed_campaign_id"),
    "new round still copies the frozen seed snapshot",
  );
  assertContract(
    !/delete\s+from\s+public\.message_logs/i.test(
      dynamicRecipientMigrationSource,
    ),
    "forward migration deletes message audit history",
  );
});

Deno.test("send requires count and hash, then atomically refreshes and claims", () => {
  assertContract(
    functionSource.includes(
      'keys === "action,recipientCount,recipientHash,roundId"',
    ) &&
      functionSource.includes("isRecipientHash(value.recipientHash)"),
    "send request is not strict about the confirmed recipient snapshot",
  );
  assertContract(
    dynamicRecipientMigrationSource.includes(
      "p_expected_recipient_hash !~ '^[a-f0-9]{64}$'",
    ) &&
      dynamicRecipientMigrationSource.includes(
        "p_expected_recipient_hash = v_recipient_hash",
      ) &&
      dynamicRecipientMigrationSource.includes(
        "extensions.digest(\n          coalesce(string_agg(recipient.phone, ',' order by recipient.phone), ''),",
      ),
    "atomic database claim is not bound to the canonical phone hash",
  );
  const atomicStage = functionSource.indexOf(
    'diagnosticStage = "refresh_and_claim_campaign"',
  );
  const firstBatch = functionSource.indexOf(
    "const configuredBatchSize",
    atomicStage,
  );
  assertContract(
    atomicStage >= 0 && firstBatch > atomicStage &&
      functionSource.includes(
        'code: "RECIPIENT_LIST_CHANGED"',
      ) &&
      !functionSource.includes('"claim_broadcast_campaign"'),
    "provider send can start before atomic recipient validation/claim",
  );
});

Deno.test("database functions stay service-role only", () => {
  for (
    const signature of [
      "assert_service_location_candidate_source_limits()",
      "get_current_service_location_broadcast_candidates()",
      "refresh_service_location_broadcast_recipients(",
      "claim_current_service_location_broadcast(",
      "prepare_broadcast_round(text, uuid, text, jsonb)",
    ]
  ) {
    assertContract(
      dynamicRecipientMigrationSource.includes(
        `revoke all on function public.${signature}`,
      ),
      `missing function revoke for ${signature}`,
    );
  }
  assertContract(
    (dynamicRecipientMigrationSource.match(/to service_role;/g) || []).length >=
        5 &&
      dynamicRecipientMigrationSource.includes(
        "from public, anon, authenticated, authenticator;",
      ),
    "current-recipient functions are exposed beyond service_role",
  );
});
