/** Cases for the Web Page URL normaliser. */
import { normalizeUrl, isCustomProtocol, isSameOrigin } from "./ui/plugins/iframe/url.js";

let pass = 0, fail = 0;
function eq( input, proto, expected ) {
	const got = normalizeUrl( input, proto );
	if( got === expected ) { pass++; console.log( `  ok   ${JSON.stringify(input)} -> ${JSON.stringify(got)}` ); }
	else { fail++; console.log( `  FAIL ${JSON.stringify(input)} -> ${JSON.stringify(got)} (wanted ${JSON.stringify(expected)})` ); }
}

console.log( "-- the reported bug: host:port read as a scheme --" );
eq( "localhost:8099",                  "http:",  "http://localhost:8099" );
eq( "localhost:8099/?doc=Demo",        "http:",  "http://localhost:8099/?doc=Demo" );
eq( "example.com:8080/a/b",            "https:", "https://example.com:8080/a/b" );

console.log( "-- scheme inherited from the page --" );
eq( "example.com",                     "http:",  "http://example.com" );
eq( "example.com",                     "https:", "https://example.com" );
eq( "example.com/status?x=1",          "https:", "https://example.com/status?x=1" );
eq( "//cdn.example.com/x",             "https:", "https://cdn.example.com/x" );

console.log( "-- already loadable: untouched --" );
eq( "http://example.com",              "https:", "http://example.com" );
eq( "https://example.com/a",           "http:",  "https://example.com/a" );
eq( "about:blank",                     "https:", "about:blank" );

console.log( "-- relative: untouched --" );
eq( "/local/page.html",                "https:", "/local/page.html" );
eq( "./page.html",                     "https:", "./page.html" );
eq( "../up.html",                      "https:", "../up.html" );

console.log( "-- real custom schemes pass through, and are flagged --" );
eq( "mailto:a@b.com",                  "https:", "mailto:a@b.com" );
eq( "tel:+15551234",                   "https:", "tel:+15551234" );

console.log( "-- edges --" );
eq( "",                                "https:", "" );
eq( "   ",                             "https:", "" );
eq( "  example.com  ",                 "https:", "https://example.com" );
eq( null,                              "https:", "" );

console.log( "-- isCustomProtocol --" );
for( const [ u, want ] of [
	[ "mailto:a@b", true ], [ "myapp:x", true ],
	[ "http://x", false ], [ "https://x", false ],
	[ "about:blank", false ], [ "", false ],
	[ "http://localhost:8099", false ],
] ) {
	const got = isCustomProtocol( u );
	if( got === want ) { pass++; console.log( `  ok   ${JSON.stringify(u)} -> ${got}` ); }
	else { fail++; console.log( `  FAIL ${JSON.stringify(u)} -> ${got} (wanted ${want})` ); }
}

console.log( "-- isSameOrigin: the port is part of the origin --" );
for( const [ u, base, want ] of [
	// The reported setup: designer on :8099 framing an app on :8085.
	[ "http://localhost:8085/PatternFinder.html", "http://localhost:8099/editor.html", false ],
	[ "http://localhost:8099/?doc=X",             "http://localhost:8099/editor.html", true  ],
	[ "https://localhost:8099/",                  "http://localhost:8099/editor.html", false ],
	[ "/relative/page.html",                      "http://localhost:8099/editor.html", true  ],
	[ "http://example.com/",                      "http://localhost:8099/editor.html", false ],
	// A bare string with no scheme resolves as a RELATIVE path against the
	// base, so it genuinely is same-origin -- not a parse failure.
	[ "some/path",                                "http://localhost:8099/editor.html", true  ],
	// Actually unparseable: no host to compare.
	[ "http://",                                  "http://localhost:8099/editor.html", false ],
] ) {
	const got = isSameOrigin( u, base );
	if( got === want ) { pass++; console.log( `  ok   ${JSON.stringify(u)} -> ${got}` ); }
	else { fail++; console.log( `  FAIL ${JSON.stringify(u)} -> ${got} (wanted ${want})` ); }
}

console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
