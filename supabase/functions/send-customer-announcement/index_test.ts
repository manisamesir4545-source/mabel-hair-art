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
