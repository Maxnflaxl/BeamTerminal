export interface SharedStateType {
  routerLink: string;
  errorMessage: string | null;
  systemState: any;
  isLoaded: boolean;
}

export interface IValidations {
  isEmpty?: boolean;
  minLength?: number;
  isEmail?: boolean;
}

export interface IUseValidation {
  value: number | string;
  validations?: IValidations;
}
export interface IUseInput {
  initialValue: number;
  validations?: IValidations;
}
