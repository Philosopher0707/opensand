export const DENIED_SECRET_REL_PATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config",
  ".netrc",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".opensand/vault",
] as const;

export type DeniedSecretRelPath = (typeof DENIED_SECRET_REL_PATHS)[number];
