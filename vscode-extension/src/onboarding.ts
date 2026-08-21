export const welcomeStateKey = "timeagent.welcomeShown.v1";
export function shouldShowWelcome(cliAvailable: boolean, alreadyShown: boolean): boolean { return cliAvailable && !alreadyShown; }
