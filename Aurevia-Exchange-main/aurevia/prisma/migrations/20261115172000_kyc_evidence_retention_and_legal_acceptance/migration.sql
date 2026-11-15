ALTER TYPE "ManagedNoticeType" ADD VALUE IF NOT EXISTS 'RISK_DISCLOSURE';
ALTER TYPE "ManagedNoticeType" ADD VALUE IF NOT EXISTS 'AML_KYC';
ALTER TYPE "ManagedNoticeType" ADD VALUE IF NOT EXISTS 'DEPOSIT_WITHDRAWAL';
ALTER TYPE "ManagedNoticeType" ADD VALUE IF NOT EXISTS 'PLATFORM_USAGE';
ALTER TYPE "ManagedNoticeType" ADD VALUE IF NOT EXISTS 'COOKIE_POLICY';
ALTER TYPE "ManagedNoticeType" ADD VALUE IF NOT EXISTS 'TRADING_AGREEMENT';

ALTER TABLE "RegistrationLegalAcceptance"
    ADD COLUMN "auditMetadata" JSONB;

ALTER TABLE "ManagedNotice"
    ADD COLUMN "requiresReacceptance" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "KycVerification"
    ADD COLUMN "supersedesId" TEXT,
    ADD COLUMN "legalHoldAt" TIMESTAMP(3),
    ADD COLUMN "legalHoldReason" VARCHAR(1000),
    ADD COLUMN "legalHoldById" TEXT,
    ADD COLUMN "evidencePurgeLockedAt" TIMESTAMP(3),
    ADD COLUMN "evidencePurgeAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "evidencePurgeNextAttemptAt" TIMESTAMP(3),
    ADD COLUMN "evidencePurgeErrorCode" VARCHAR(64),
    ADD COLUMN "evidencePurgeFailedAt" TIMESTAMP(3);

ALTER TABLE "KycVerification"
    ADD CONSTRAINT "KycVerification_supersedesId_fkey"
    FOREIGN KEY ("supersedesId") REFERENCES "KycVerification"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "KycVerification_legalHoldById_fkey"
    FOREIGN KEY ("legalHoldById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "KycVerificationArchive" (
    "verificationId" TEXT NOT NULL,
    "applicantReference" CHAR(64) NOT NULL,
    "decisionStatus" "KycVerificationStatus" NOT NULL,
    "decisionCategory" VARCHAR(32) NOT NULL,
    "reviewerReference" CHAR(64),
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "evidencePurgedAt" TIMESTAMP(3) NOT NULL,
    "evidencePurgeOutcome" VARCHAR(64) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "legalHoldAt" TIMESTAMP(3),
    "legalHoldReason" VARCHAR(1000),
    "legalHoldActorReference" CHAR(64),
    "retentionPurgeLockedAt" TIMESTAMP(3),
    "retentionPurgeAttempts" INTEGER NOT NULL DEFAULT 0,
    "retentionPurgeNextAttemptAt" TIMESTAMP(3),
    "retentionPurgeErrorCode" VARCHAR(64),
    "retentionPurgeFailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KycVerificationArchive_pkey" PRIMARY KEY ("verificationId")
);

CREATE TABLE "KycRetentionEvent" (
    "id" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "actorReference" CHAR(64),
    "action" VARCHAR(64) NOT NULL,
    "fromStatus" "KycVerificationStatus",
    "toStatus" "KycVerificationStatus",
    "reason" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KycRetentionEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KycRetentionEvent_verificationId_fkey"
        FOREIGN KEY ("verificationId") REFERENCES "KycVerificationArchive"("verificationId")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "KycVerification_status_reviewedAt_legalHoldAt_evidencePurgeNextAttemptAt_idx"
    ON "KycVerification"("status", "reviewedAt", "legalHoldAt", "evidencePurgeNextAttemptAt");
CREATE INDEX "KycVerification_supersedesId_idx"
    ON "KycVerification"("supersedesId");
CREATE INDEX "KycVerificationArchive_retainUntil_legalHoldAt_retentionPurgeNextAttemptAt_idx"
    ON "KycVerificationArchive"("retainUntil", "legalHoldAt", "retentionPurgeNextAttemptAt");
CREATE INDEX "KycVerificationArchive_decisionStatus_decidedAt_idx"
    ON "KycVerificationArchive"("decisionStatus", "decidedAt");
CREATE INDEX "KycRetentionEvent_verificationId_createdAt_idx"
    ON "KycRetentionEvent"("verificationId", "createdAt");

ALTER TABLE "KycVerificationArchive" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KycRetentionEvent" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "KycVerificationArchive", "KycRetentionEvent" FROM PUBLIC, anon, authenticated;
