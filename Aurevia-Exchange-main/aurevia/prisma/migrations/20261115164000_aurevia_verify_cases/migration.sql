CREATE TYPE "KycVerificationStatus" AS ENUM (
    'DRAFT',
    'SUBMITTED',
    'PROCESSING',
    'PENDING_REVIEW',
    'NEEDS_REVIEW',
    'RESUBMISSION_REQUIRED',
    'APPROVED',
    'REJECTED',
    'CANCELLED',
    'EXPIRED'
);

CREATE TABLE "KycVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "KycVerificationStatus" NOT NULL DEFAULT 'DRAFT',
    "documentCountry" VARCHAR(2) NOT NULL,
    "documentType" VARCHAR(32) NOT NULL,
    "registryVersion" VARCHAR(32) NOT NULL,
    "consentVersion" VARCHAR(64) NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "assignedToId" TEXT,
    "decisionReason" VARCHAR(1000),
    "internalNote" VARCHAR(2000),
    "assessment" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KycVerification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KycVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KycVerification_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "KycVerification_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "KycVerificationEvent" (
    "id" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "actorId" TEXT,
    "fromStatus" "KycVerificationStatus",
    "toStatus" "KycVerificationStatus" NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(1000),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KycVerificationEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KycVerificationEvent_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "KycVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KycVerificationEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "KycDocument"
    ADD COLUMN "verificationId" TEXT,
    ADD COLUMN "documentSide" VARCHAR(32),
    ADD COLUMN "sha256" CHAR(64);

ALTER TABLE "KycDocument"
    ADD CONSTRAINT "KycDocument_verificationId_fkey"
    FOREIGN KEY ("verificationId") REFERENCES "KycVerification"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "KycVerification_userId_status_createdAt_idx" ON "KycVerification"("userId", "status", "createdAt");
CREATE INDEX "KycVerification_status_submittedAt_idx" ON "KycVerification"("status", "submittedAt");
CREATE INDEX "KycVerification_reviewedById_reviewedAt_idx" ON "KycVerification"("reviewedById", "reviewedAt");
CREATE INDEX "KycVerification_assignedToId_status_submittedAt_idx" ON "KycVerification"("assignedToId", "status", "submittedAt");
CREATE INDEX "KycVerificationEvent_verificationId_createdAt_idx" ON "KycVerificationEvent"("verificationId", "createdAt");
CREATE INDEX "KycVerificationEvent_actorId_createdAt_idx" ON "KycVerificationEvent"("actorId", "createdAt");
CREATE INDEX "KycDocument_verificationId_kind_idx" ON "KycDocument"("verificationId", "kind");
CREATE UNIQUE INDEX "KycVerification_one_open_per_user_idx" ON "KycVerification"("userId")
    WHERE "status" IN ('DRAFT', 'SUBMITTED', 'PROCESSING', 'PENDING_REVIEW', 'NEEDS_REVIEW', 'RESUBMISSION_REQUIRED');

ALTER TABLE "KycVerification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KycVerificationEvent" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "KycVerification", "KycVerificationEvent" FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "KycDocument" FROM PUBLIC, anon, authenticated;
