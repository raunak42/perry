type OutputWriter = (message: string) => void;

const defaultWriter: OutputWriter = (message) => {
    console.log(message);
};

let outputWriter: OutputWriter = defaultWriter;

export function setOutputWriter(writer: OutputWriter | null): void {
    outputWriter = writer ?? defaultWriter;
}

export function writeOutput(message: string): void {
    outputWriter(message);
}
