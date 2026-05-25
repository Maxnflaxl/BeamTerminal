export interface InputErrorState {
  hasError: boolean;
  message: string;
}

export function createInputErrorState(
  condition: boolean,
  message: string,
): InputErrorState {
  return {
    hasError: condition,
    message,
  };
}
