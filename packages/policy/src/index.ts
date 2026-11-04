export { checkPolicy, type PolicyInput, type PolicyResult } from './check.ts';
export { checkPaths, checkDependencies, checkAddedLines, type Violation, type FileChange, type AddedLine } from './rules.ts';
export { createWriteGuard, type WriteGuard } from './guard.ts';
