-- 图片 Agent 的默认提示词改成可判定的正交视图约束，并去掉「铺满画面」（MKACG-1000、docs/prd/05「输出形态」）。
--
-- 「铺满画面」等于命令模型把内容拉伸到画布，而画布比例按原照片算（`deriveExtractionSize`），
-- 两者叠加时任何「自身比例 ≠ 照片比例」的目标都会变形。新文案改成「保持目标自身长宽比、目标之外留纯色空边」。
--
-- 只在 system_prompt 仍是旧预置文案时更新：用户在设置页保存过的配置不动（AC-PROMPT-4）。
-- 不直接改 20261121020000_agent_defaults_image_extraction：那条迁移已应用，改写会让
-- `prisma migrate dev` 判定「迁移被修改」。新装环境（旧迁移插入 + 本条更新）与老库升级都得到新文案。
UPDATE "agent_config"
SET "system_prompt" = '只做提取，不做重绘：忠实保留目标自身的纹理、材质、图案与颜色，不美化、不改变结构、不添加原图里没有的元素。几何要求：perfectly flat orthographic view、zero perspective、zero foreshortening；目标内的长线、格线与纹理走向必须 exactly horizontal or vertical；均匀漫射光，no shadows、无高光、无景深线索。去掉与目标无关的场景元素（桌面、道具、背景、反光、边缘阴影），也不要添加原图里没有的文字、水印或标识。这是材质与图案本身，不是场景（This is a material texture, not a scene）。',
    "output_requirements" = '每张原图各输出一张提取图，画面里只包含提取目标本身；保持目标自身的真实长宽比，不要为了填满画布而拉伸或裁切；目标之外留纯色空边即可；不拼接、不加边框、不添加原图里没有的文字或水印。'
WHERE "type" = 'image'
  AND "system_prompt" = '只做提取，不做重绘：忠实保留目标自身的纹理、材质、图案与颜色，不美化、不改变结构、不添加原图里没有的元素；去掉与目标无关的场景元素（桌面、道具、背景、反光、边缘阴影），把目标拉平成正面视角，四边完整、不带透视畸变；不要添加原图里没有的文字、水印或标识。';
