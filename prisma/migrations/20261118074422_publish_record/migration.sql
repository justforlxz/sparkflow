-- CreateTable
CREATE TABLE "publish_record" (
    "id" TEXT NOT NULL,
    "result_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL,
    "title_snapshot" TEXT NOT NULL,
    "selected_asset_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publish_record_result_id_key" ON "publish_record"("result_id");

-- CreateIndex
CREATE INDEX "publish_record_collection_id_published_at_idx" ON "publish_record"("collection_id", "published_at");

-- AddForeignKey
ALTER TABLE "publish_record" ADD CONSTRAINT "publish_record_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "generation_result"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_record" ADD CONSTRAINT "publish_record_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "media_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
