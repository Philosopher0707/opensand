function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export class LineDecoder {
  private pending = "";

  push(chunk: string): string[] {
    const parts = (this.pending + chunk).split("\n");
    this.pending = parts.pop() ?? "";
    return parts.map(stripCarriageReturn).filter((line) => line.length > 0);
  }

  flush(): string | null {
    const rest = stripCarriageReturn(this.pending);
    this.pending = "";
    return rest.length > 0 ? rest : null;
  }
}
