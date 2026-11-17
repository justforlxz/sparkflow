-- CreateTable
CREATE TABLE "media_collection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT,
    "source_url" TEXT,
    "source_title" TEXT,
    "source_body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_asset" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_asset_collection_id_sort_order_idx" ON "media_asset"("collection_id", "sort_order");

-- AddForeignKey
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "media_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
