// Custom-resource onEvent shim (CDK Provider framework): invites the first admin (ConsoleStack -c adminEmail=...).
export { seedAdminHandler as handler } from '../packages/console-api/src/seed.ts'
