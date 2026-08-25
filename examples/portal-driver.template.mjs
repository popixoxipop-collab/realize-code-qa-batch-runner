/**
 * Copy this file to portal-driver.local.mjs and connect it to browser sessions
 * that are isolated by profile. Never return or persist passwords, cookies, or
 * tokens. The batch runner intentionally owns orchestration, not credentials.
 */
export async function createPortalAdapter({ profileIds, repositoryUrl, round }) {
  // Replace this with your Browser/automation bridge. Each profile ID must map
  // to exactly one distinct authentication context for the whole run.
  const sessions = new Map();

  const sessionFor = (profileId) => {
    const session = sessions.get(profileId);
    if (!session) throw Object.assign(new Error(`No browser session for ${profileId}`), { code: "PROFILE_NOT_CONNECTED" });
    return session;
  };

  return {
    async listClasses() {
      // Return live visible class labels, for example ["E반", "F반"].
      throw Object.assign(new Error("Implement listClasses() from the login page."), { code: "DRIVER_NOT_IMPLEMENTED" });
    },

    async getRound({ className }) {
      // Return a stable round ID/label, not merely "current".
      void className;
      return round;
    },

    async listProfileIds() {
      return profileIds;
    },

    async verifyIsolatedProfiles({ profileIds: requested }) {
      // Compare real browser profile/context identifiers here. Returning true
      // is a safety assertion that no two requested IDs share cookies.
      const isolationKeys = await Promise.all(requested.map(async (profileId) => sessionFor(profileId).isolationKey()));
      return isolationKeys.every((key) => typeof key === "string" && key.trim().length > 0)
        && isolationKeys.length === new Set(isolationKeys).size;
    },

    async getRoster({ className }) {
      // Read the visible login roster. Required shape:
      // { accountId, displayName, className, teamId, teamName, role }
      // role must be exactly "교육생" or "매니저".
      void className;
      throw Object.assign(new Error("Implement getRoster() from the visible account list."), { code: "DRIVER_NOT_IMPLEMENTED" });
    },

    async submitRepositoryOnce({ profileId, team, representative }) {
      // Log in as representative, verify the account banner and repository,
      // then submit exactly once. Return only after visible confirmation.
      return sessionFor(profileId).submitRepositoryOnce({ team, representative, repositoryUrl });
    },

    async confirmTeamSubmission({ profileId, team, representative, verifier }) {
      // Log into a different trainee account and confirm the same repository
      // state is visible before the ledger marks the team submission confirmed.
      return sessionFor(profileId).confirmTeamSubmission({ team, representative, verifier, repositoryUrl });
    },

    async waitAnalysisReady({ profileId, team, representative }) {
      return sessionFor(profileId).waitAnalysisReady({ team, representative });
    },

    async runAccount({ profileId, team, account, checkpoints, resume }) {
      // The session implementation should createRealizeBatchRunner() with an
      // exact fingerprint answer bank. Pass these central callbacks and resume
      // data into it; do not create a separate per-session checkpoint store.
      return sessionFor(profileId).runAccount({
        team,
        account,
        checkpoints,
        resume,
      });
    },
  };
}

export default createPortalAdapter;
