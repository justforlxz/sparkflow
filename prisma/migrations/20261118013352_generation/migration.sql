-- CreateTable
CREATE TABLE "generation_task" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "visual_style" TEXT NOT NULL,
    "copy_style" TEXT NOT NULL,
    "image_count" INTEGER NOT NULL,
    "extra_prompt" TEXT,
    "agent_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_stage" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "meta" JSONB,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "generation_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_result" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visual_style" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_asset" (
    "id" TEXT NOT NULL,
    "result_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,

    CONSTRAINT "generated_asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_task_collection_id_created_at_idx" ON "generation_task"("collection_id", "created_at");

-- CreateIndex
CREATE INDEX "generation_stage_status_idx" ON "generation_stage"("status");

-- CreateIndex
CREATE UNIQUE INDEX "generation_stage_task_id_stage_key" ON "generation_stage"("task_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "generation_result_task_id_key" ON "generation_result"("task_id");

-- CreateIndex
CREATE INDEX "generation_result_collection_id_created_at_idx" ON "generation_result"("collection_id", "created_at");

-- CreateIndex
CREATE INDEX "generated_asset_result_id_sort_order_idx" ON "generated_asset"("result_id", "sort_order");

-- AddForeignKey
ALTER TABLE "generation_task" ADD CONSTRAINT "generation_task_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "media_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_stage" ADD CONSTRAINT "generation_stage_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "generation_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_result" ADD CONSTRAINT "generation_result_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "media_collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_result" ADD CONSTRAINT "generation_result_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "generation_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_asset" ADD CONSTRAINT "generated_asset_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "generation_result"("id") ON DELETE CASCADE ON UPDATE CASCADE;
