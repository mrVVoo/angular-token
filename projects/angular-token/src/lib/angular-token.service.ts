import { Injectable, Optional, Inject, PLATFORM_ID } from '@angular/core';
import { ActivatedRoute, Router, CanActivate } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { isPlatformServer } from '@angular/common';

import { Observable, fromEvent, interval, BehaviorSubject } from 'rxjs';
import { pluck, filter, share, finalize } from 'rxjs/operators';

import { ANGULAR_TOKEN_OPTIONS } from './angular-token.token';
import {
  SignInData,
  RegisterData,
  UpdatePasswordData,
  ResetPasswordData,
  UserType,
  UserData,
  AuthData,
  AngularTokenOptions
} from './angular-token.model';

@Injectable({
  providedIn: 'root',
})
export class AngularTokenService implements CanActivate {

  public options: BehaviorSubject<AngularTokenOptions> = new BehaviorSubject(null);
  public userType: BehaviorSubject<UserType> = new BehaviorSubject(null);
  public authData: BehaviorSubject<AuthData> = new BehaviorSubject(null);
  public userData: BehaviorSubject<UserData> = new BehaviorSubject(null);

  private global: Window | any;
  private localStorage: Storage | any = {};

  constructor(
    private http: HttpClient,
    @Inject(ANGULAR_TOKEN_OPTIONS) config: any,
    @Inject(PLATFORM_ID) private platformId: Object,
    @Optional() private activatedRoute: ActivatedRoute,
    @Optional() private router: Router
  ) {
    this.global = (typeof window !== 'undefined') ? window : {};

    if (isPlatformServer(platformId)) {
      this.global = {
        open: () => null,
        location: {
          href: '/',
          origin: '/'
        }
      };

      this.localStorage.setItem = () => null;
      this.localStorage.getItem = () => null;
      this.localStorage.removeItem = () => null;
    } else {
      this.localStorage = localStorage;
    }

    const defaultOptions: AngularTokenOptions = {
      apiPath:                    null,
      apiBase:                    null,

      signInPath:                 'auth/sign_in',
      signInRedirect:             null,
      signInStoredUrlStorageKey:  null,

      signOutPath:                'auth/sign_out',
      validateTokenPath:          'auth/validate_token',
      signOutFailedValidate:      false,

      registerAccountPath:        'auth',
      deleteAccountPath:          'auth',
      registerAccountCallback:    this.global.location.href,

      updatePasswordPath:         'auth',

      resetPasswordPath:          'auth/password',
      resetPasswordCallback:      this.global.location.href,

      userTypes:                  null,
      loginField:                 'email',

      oAuthBase:                  this.global.location.origin,
      oAuthPaths: {
        github:                   'auth/github'
      },
      oAuthCallbackPath:          'oauth_callback',
      oAuthWindowType:            'newWindow',
      oAuthWindowOptions:         null,
    };

    const mergedOptions = (<any>Object).assign(defaultOptions, config);
    this.options.next(mergedOptions);

    if (this.options.value.apiBase === null) {
      console.warn(`[angular-token] You have not configured 'apiBase', which may result in security issues. ` +
                   `Please refer to the documentation at https://github.com/neroniaky/angular-token/wiki`);
    }

    this.tryLoadAuthData();
  }

  userSignedIn(): boolean {
    return !!this.authData.value;
  }

  canActivate(route, state): boolean {
    if (this.userSignedIn()) {
      return true;
    } else {
      // Store current location in storage (usefull for redirection after signing in)
      if (this.options.value.signInStoredUrlStorageKey) {
        this.localStorage.setItem(
          this.options.value.signInStoredUrlStorageKey,
          state.url
        );
      }

      // Redirect user to sign in if signInRedirect is set
      if (this.router && this.options.value.signInRedirect) {
        this.router.navigate([this.options.value.signInRedirect]);
      }

      return false;
    }
  }


  /**
   *
   * Actions
   *
   */

  // Register request
  registerAccount(registerData: RegisterData): Observable<any> {

    registerData = Object.assign({}, registerData);

    if (registerData.userType == null) {
      this.userType.next(null);
    } else {
      this.userType.next(this.getUserTypeByName(registerData.userType));
      delete registerData.userType;
    }

    if (
      registerData.password_confirmation == null &&
      registerData.passwordConfirmation != null
    ) {
      registerData.password_confirmation = registerData.passwordConfirmation;
      delete registerData.passwordConfirmation;
    }

    const login = registerData.login;
    delete registerData.login;
    registerData[this.options.value.loginField] = login;

    registerData.confirm_success_url = this.options.value.registerAccountCallback;

    return this.http.post(this.getServerPath() + this.options.value.registerAccountPath, registerData);
  }

  // Delete Account
  deleteAccount(): Observable<any> {
    return this.http.delete(this.getServerPath() + this.options.value.deleteAccountPath);
  }

  // Sign in request and set storage
  signIn(signInData: SignInData): Observable<any> {
    this.userType.next((signInData.userType == null) ? null : this.getUserTypeByName(signInData.userType));

    const body = {
      [this.options.value.loginField]: signInData.login,
      password: signInData.password
    };

    const observ = this.http.post(this.getServerPath() + this.options.value.signInPath, body, { observe: 'response' }).pipe(share());

    observ.subscribe(res => {this.userData.next(res.body['data']); console.log(res.body); });

    return observ;
  }

  signInOAuth(oAuthType: string) {

    const oAuthPath: string = this.getOAuthPath(oAuthType);
    const callbackUrl = `${this.global.location.origin}/${this.options.value.oAuthCallbackPath}`;
    const oAuthWindowType: string = this.options.value.oAuthWindowType;
    const authUrl: string = this.getOAuthUrl(oAuthPath, callbackUrl, oAuthWindowType);

    if (oAuthWindowType === 'newWindow') {
      const oAuthWindowOptions = this.options.value.oAuthWindowOptions;
      let windowOptions = '';

      if (oAuthWindowOptions) {
        for (const key in oAuthWindowOptions) {
          if (oAuthWindowOptions.hasOwnProperty(key)) {
              windowOptions += `,${key}=${oAuthWindowOptions[key]}`;
          }
        }
      }

      const popup = window.open(
          authUrl,
          '_blank',
          `closebuttoncaption=Cancel${windowOptions}`
      );
      return this.requestCredentialsViaPostMessage(popup);
    } else if (oAuthWindowType === 'sameWindow') {
      this.global.location.href = authUrl;
    } else {
      throw new Error(`Unsupported oAuthWindowType "${oAuthWindowType}"`);
    }
  }

  processOAuthCallback(): void {
    this.getAuthDataFromParams();
  }

  // Sign out request and delete storage
  signOut(): Observable<any> {
    const observ = this.http.delete<any>(this.getServerPath() + this.options.value.signOutPath).pipe(
    // Only remove the localStorage and clear the data after the call
      finalize(() => {
          this.localStorage.removeItem('accessToken');
          this.localStorage.removeItem('client');
          this.localStorage.removeItem('expiry');
          this.localStorage.removeItem('tokenType');
          this.localStorage.removeItem('uid');

          this.authData.next(null);
          this.userType.next(null);
          this.userData.next(null);
    }));

    return observ;
  }

  // Validate token request
  validateToken(): Observable<any> {
    const observ = this.http.get(this.getServerPath() + this.options.value.validateTokenPath).pipe(share());

    observ.subscribe(
      (res) => this.userData.next(res['data']),
      (error) => {
        if (error.status === 401 && this.options.value.signOutFailedValidate) {
          this.signOut();
        }
    });

    return observ;
  }

  // Update password request
  updatePassword(updatePasswordData: UpdatePasswordData): Observable<any> {

    if (updatePasswordData.userType != null) {
      this.userType.next(this.getUserTypeByName(updatePasswordData.userType));
    }

    let args: any;

    if (updatePasswordData.passwordCurrent == null) {
      args = {
        password:               updatePasswordData.password,
        password_confirmation:  updatePasswordData.passwordConfirmation
      };
    } else {
      args = {
        current_password:       updatePasswordData.passwordCurrent,
        password:               updatePasswordData.password,
        password_confirmation:  updatePasswordData.passwordConfirmation
      };
    }

    if (updatePasswordData.resetPasswordToken) {
      args.reset_password_token = updatePasswordData.resetPasswordToken;
    }

    const body = args;
    return this.http.put(this.getServerPath() + this.options.value.updatePasswordPath, body);
  }

  // Reset password request
  resetPassword(resetPasswordData: ResetPasswordData): Observable<any> {

    this.userType.next((resetPasswordData.userType == null) ? null : this.getUserTypeByName(resetPasswordData.userType));

    const body = {
      [this.options.value.loginField]: resetPasswordData.login,
      redirect_url: this.options.value.resetPasswordCallback
    };

    return this.http.post(this.getServerPath() + this.options.value.resetPasswordPath, body);
  }


  /**
   *
   * Construct Paths / Urls
   *
   */

  private getUserPath(): string {
    return (this.userType.value == null) ? '' : this.userType.value.path + '/';
  }

  private getApiPath(): string {
    let constructedPath = '';

    if (this.options.value.apiBase != null) {
      constructedPath += this.options.value.apiBase + '/';
    }

    if (this.options.value.apiPath != null) {
      constructedPath += this.options.value.apiPath + '/';
    }

    return constructedPath;
  }

  private getServerPath(): string {
    return this.getApiPath() + this.getUserPath();
  }

  private getOAuthPath(oAuthType: string): string {
    let oAuthPath: string;

    oAuthPath = this.options.value.oAuthPaths[oAuthType];

    if (oAuthPath == null) {
      oAuthPath = `/auth/${oAuthType}`;
    }

    return oAuthPath;
  }

  private getOAuthUrl(oAuthPath: string, callbackUrl: string, windowType: string): string {
    let url: string;

    url =   `${this.options.value.oAuthBase}/${oAuthPath}`;
    url +=  `?omniauth_window_type=${windowType}`;
    url +=  `&auth_origin_url=${encodeURIComponent(callbackUrl)}`;

    if (this.userType.value != null) {
      url += `&resource_class=${this.userType.value.name}`;
    }

    return url;
  }


  /**
   *
   * Get Auth Data
   *
   */

  // Try to load auth data
  private tryLoadAuthData(): void {

    const userType = this.getUserTypeByName(this.localStorage.getItem('userType'));

    if (userType) {
      this.userType.next(userType);
    }

    this.getAuthDataFromStorage();

    if (this.activatedRoute) {
      this.getAuthDataFromParams();
    }

    // if (this.authData) {
    //     this.validateToken();
    // }
  }

  // Parse Auth data from response
  public getAuthHeadersFromResponse(data: any): void {
    const headers = data.headers;

    const authData: AuthData = {
      accessToken:    headers.get('access-token'),
      client:         headers.get('client'),
      expiry:         headers.get('expiry'),
      tokenType:      headers.get('token-type'),
      uid:            headers.get('uid')
    };

    this.setAuthData(authData);
  }

  // Parse Auth data from post message
  private getAuthDataFromPostMessage(data: any): void {
    const authData: AuthData = {
      accessToken:    data['auth_token'],
      client:         data['client_id'],
      expiry:         data['expiry'],
      tokenType:      'Bearer',
      uid:            data['uid']
    };

    this.setAuthData(authData);
  }

  // Try to get auth data from storage.
  public getAuthDataFromStorage(): void {

    const authData: AuthData = {
      accessToken:    this.localStorage.getItem('accessToken'),
      client:         this.localStorage.getItem('client'),
      expiry:         this.localStorage.getItem('expiry'),
      tokenType:      this.localStorage.getItem('tokenType'),
      uid:            this.localStorage.getItem('uid')
    };

    if (this.checkAuthData(authData)) {
      this.authData.next(authData);
    }
  }

  // Try to get auth data from url parameters.
  private getAuthDataFromParams(): void {
    this.activatedRoute.queryParams.subscribe(queryParams => {
      const authData: AuthData = {
        accessToken:    queryParams['token'] || queryParams['auth_token'],
        client:         queryParams['client_id'],
        expiry:         queryParams['expiry'],
        tokenType:      'Bearer',
        uid:            queryParams['uid']
      };

      if (this.checkAuthData(authData)) {
        this.authData.next(authData);
      }
    });
  }

  /**
   *
   * Set Auth Data
   *
   */

  // Write auth data to storage
  private setAuthData(authData: AuthData): void {
    if (this.checkAuthData(authData)) {
      this.localStorage.setItem('accessToken', authData.accessToken);
      this.localStorage.setItem('client', authData.client);
      this.localStorage.setItem('expiry', authData.expiry);
      this.localStorage.setItem('tokenType', authData.tokenType);
      this.localStorage.setItem('uid', authData.uid);

      this.authData.next(authData);

      if (this.userType.value != null) {
        this.localStorage.setItem('userType', this.userType.value.name);
      }
    }
  }

  /**
   *
   * Validate Auth Data
   *
   */

  // Check if auth data complete and if response token is newer
  private checkAuthData(authData: AuthData): boolean {

    if (
      authData.accessToken != null &&
      authData.client != null &&
      authData.expiry != null &&
      authData.tokenType != null &&
      authData.uid != null
    ) {
      if (this.authData.value != null) {
        return authData.expiry >= this.authData.value.expiry;
      }

      return true;
    }

    return false;
  }


  /**
   *
   * OAuth
   *
   */

  private requestCredentialsViaPostMessage(authWindow: any): Observable<any> {
    const pollerObserv = interval(500);

    const responseObserv = fromEvent(this.global, 'message').pipe(
      pluck('data'),
      filter(this.oAuthWindowResponseFilter)
    );

    const responseSubscription = responseObserv.subscribe(
      this.getAuthDataFromPostMessage.bind(this)
    );

    const pollerSubscription = pollerObserv.subscribe(() => {
      if (authWindow.closed) {
        pollerSubscription.unsubscribe();
      } else {
        authWindow.postMessage('requestCredentials', '*');
      }
    });

    return responseObserv;
  }

  private oAuthWindowResponseFilter(data: any): any {
    if (data.message === 'deliverCredentials' || data.message === 'authFailure') {
      return data;
    }
  }


  /**
   *
   * Utilities
   *
   */

  // Match user config by user config name
  private getUserTypeByName(name: string): UserType {
    if (name == null || this.options.value.userTypes == null) {
      return null;
    }

    return this.options.value.userTypes.find(
      userType => userType.name === name
    );
  }
}