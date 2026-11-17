-- CreateTable
CREATE TABLE "gateway" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "encrypted_api_key" TEXT NOT NULL,
    "last_test_status" TEXT,
    "last_test_message" TEXT,
    "last_tested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_model" (
    "id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_model_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gateway_model_capability_idx" ON "gateway_model"("capability");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_model_gateway_id_model_id_key" ON "gateway_model"("gateway_id", "model_id");

-- AddForeignKey
ALTER TABLE "gateway_model" ADD CONSTRAINT "gateway_model_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;
