import packageJson from "../../package.json";

/** 版本号：默认取 package.json，允许用环境变量覆盖（例如镜像标签）。 */
export const APP_VERSION: string = process.env.APP_VERSION?.trim() || packageJson.version;
