ALTER TABLE "User"
    ADD COLUMN "firstName" TEXT,
    ADD COLUMN "middleName" TEXT,
    ADD COLUMN "lastName" TEXT,
    ADD COLUMN "nationality" TEXT,
    ADD COLUMN "preferredLanguage" TEXT,
    ADD COLUMN "alternativePhone" TEXT,
    ADD COLUMN "preferredContactMethod" TEXT;

ALTER TABLE "KycProfile"
    ADD COLUMN "addressLine1" TEXT,
    ADD COLUMN "addressLine2" TEXT,
    ADD COLUMN "apartment" TEXT,
    ADD COLUMN "buildingName" TEXT,
    ADD COLUMN "city" TEXT,
    ADD COLUMN "district" TEXT,
    ADD COLUMN "stateProvince" TEXT,
    ADD COLUMN "postalCode" TEXT,
    ADD COLUMN "addressCountry" TEXT,
    ADD COLUMN "addressType" TEXT;

CREATE TABLE "RegistrationLegalAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "documentKey" VARCHAR(64) NOT NULL,
    "version" VARCHAR(128) NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistrationLegalAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistrationLegalAcceptance_userId_documentKey_version_key"
    ON "RegistrationLegalAcceptance"("userId", "documentKey", "version");
CREATE INDEX "RegistrationLegalAcceptance_userId_acceptedAt_idx"
    ON "RegistrationLegalAcceptance"("userId", "acceptedAt");

ALTER TABLE "RegistrationLegalAcceptance"
    ADD CONSTRAINT "RegistrationLegalAcceptance_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
