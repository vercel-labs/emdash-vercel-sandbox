export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
  }
}

export class OwnershipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OwnershipError';
  }
}

export class HostIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostIdentityError';
  }
}
