/** Props for TaskOutput component */
export interface TaskOutputProps {
  lines: string[]
}

/** Renders the last few lines of task output */
export const TaskOutput = ({ lines }: TaskOutputProps) => {
  // Show last 2 lines of output
  const lastLines = lines.slice(-2)

  return (
    <box flexDirection="column" marginLeft={2}>
      {lastLines.map((line, i) => (
        <text key={i} fg="gray">
          │ {line.length > 77 ? line.slice(0, 77) + '...' : line}
        </text>
      ))}
    </box>
  )
}
